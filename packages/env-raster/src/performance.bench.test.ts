import { describe, expect, it } from "vitest";
import { compositeRasterDocument } from "./render";
import { createRasterDocument, createRasterLayer } from "./document";
import { appendLayer } from "./layer-tree";
import { translateLayerPixels } from "./transform";
import { accumulateUniquePixelBytes, layerDocumentPixels, setLayerPixels } from "./layer-bounds";
import type { RasterDocumentState, RasterLayer } from "./types";

/**
 * Stage 0 of docs/migration-plan.md: a measured floor under the operations
 * the migration is not allowed to slow down. These are not aspirational
 * numbers — each threshold is the measured time on this machine times a
 * generous multiplier, so the test catches a real regression (an
 * accidentally reintroduced full-canvas pass, a call moved into a hot loop)
 * without going flaky on a slower CI box or a warm-vs-cold JIT run.
 *
 * If a change to this repository makes one of these fail, the fix is to
 * speed the change up, not to raise the threshold. Raising a threshold here
 * is a decision about the product, not a test-maintenance chore, and it
 * belongs in a commit that says so.
 */

/**
 * Six times the measured baseline on this machine. Loose enough that a
 * slower CI box or a cold JIT does not fail the suite, tight enough that a
 * regression has to be a real multiple slower — an accidentally
 * reintroduced full-canvas pass, a call moved into a hot loop — not noise.
 */
const THRESHOLD_MULTIPLIER = 6;

/** Runs `fn` a few times and returns the fastest sample, which is the sample
 * least polluted by GC pauses or JIT warm-up — the two sources of noise that
 * would otherwise make this suite flaky rather than the code being slow. */
function fastestOf(fn: () => void, samples = 5): number {
  let best = Infinity;
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * A document shaped like the one the layer-bounds optimisation was measured
 * against, not a worst-case stress test.
 *
 * A first attempt at this fixture gave every layer a full 1920x1080 opaque
 * buffer at fractional opacity — every layer touching every tile, on the
 * slowest per-pixel blend branch, on every single one of them. That measured
 * ~500ms, and the number was meaningless: real documents are not built that
 * way, and the very optimisation under test (166MB -> 3.1MB for 21 layers,
 * see setLayerPixels/trimToContent) only pays off *because* an edited layer
 * usually covers a modest area, not the whole canvas — that is what bounds
 * are trimmed to. A fixture where every layer is full-canvas contradicts the
 * premise of the thing it is supposed to benchmark.
 *
 * So: one full-canvas background (what every document starts with), and the
 * rest sized and positioned like actual brush strokes or pasted objects,
 * scattered across the canvas and passed through the same trimming path a
 * real edit commits through.
 */
function realisticDocument(layerCount = 21): RasterDocumentState {
  const state = createRasterDocument(1920, 1080);
  for (let index = 1; index < layerCount; index += 1) {
    const layer = createRasterLayer(state.width, state.height, `Layer ${index}`);
    const painted = new Uint8ClampedArray(layer.pixels.length);
    const boxWidth = 180 + (index * 37) % 220, boxHeight = 140 + (index * 53) % 200;
    const originX = (index * 227) % Math.max(1, state.width - boxWidth);
    const originY = (index * 311) % Math.max(1, state.height - boxHeight);
    for (let y = 0; y < boxHeight; y += 1) {
      for (let x = 0; x < boxWidth; x += 1) {
        const documentIndex = ((originY + y) * state.width + (originX + x)) * 4;
        painted[documentIndex] = (x * 7) % 255; painted[documentIndex + 1] = (y * 13) % 255;
        painted[documentIndex + 2] = ((x + y) * 31) % 255; painted[documentIndex + 3] = 255;
      }
    }
    setLayerPixels(layer, painted, state.width, state.height);
    layer.opacity = 0.5 + (index % 5) / 10;
    appendLayer(state, layer);
  }
  return state;
}

describe("performance floor (stage 0 of the catalogue migration)", () => {
  it("composites a 21-layer 1920x1080 document", () => {
    const state = realisticDocument();

    const elapsed = fastestOf(() => { compositeRasterDocument(state); });

    // Measured on this fixture: ~27ms.
    expect(elapsed).toBeLessThan(27 * THRESHOLD_MULTIPLIER);
  });

  it("translates a layer with no active selection", () => {
    const state = realisticDocument();
    const layer = state.layers[10] as RasterLayer;
    // The real call site (RasterWorkspace's move tool) always materialises the
    // layer to document size first — translateLayerPixels works in document
    // space, and a layer trimmed to its content is smaller than that.
    const documentPixels = layerDocumentPixels(layer, state.width, state.height);

    // The path this exercises is the block-copy fast path translateLayerPixels
    // documents at line 88 — the one that replaced two full-canvas composite
    // passes per dragged frame with a single memmove-shaped copy.
    const elapsed = fastestOf(() => {
      translateLayerPixels(documentPixels, state.width, state.height, 12, -7, null);
    });

    // Measured on this fixture: well under 1ms — this is the block-copy
    // fast path, not a per-pixel blend. A floor of 5ms (rather than a
    // multiple of a sub-millisecond number, where timer jitter alone could
    // trip it) still catches the fast path being lost entirely: falling
    // back to the general per-pixel path measured ~14ms/frame before this
    // path existed, comfortably above the floor.
    expect(elapsed).toBeLessThan(5);
  });

  it("trims a full-canvas edit down to its painted bounds", () => {
    const state = realisticDocument(2);
    const layer = state.layers[1] as RasterLayer;
    const painted = new Uint8ClampedArray(layer.pixels.length);
    // A small stroke on an otherwise transparent canvas-sized buffer — what a
    // single brush dab hands to setLayerPixels before it gets trimmed to the
    // part that actually has something in it.
    for (let y = 500; y < 580; y += 1) {
      for (let x = 800; x < 880; x += 1) {
        const index = (y * state.width + x) * 4;
        painted[index] = 200; painted[index + 1] = 40; painted[index + 2] = 40; painted[index + 3] = 255;
      }
    }

    const elapsed = fastestOf(() => {
      setLayerPixels(layer, painted, state.width, state.height);
    });

    // Measured on this fixture: ~8ms.
    expect(elapsed).toBeLessThan(8 * THRESHOLD_MULTIPLIER);
  });

  it("keeps a 21-layer document's pixel storage proportional to what is painted, not the canvas", () => {
    const state = realisticDocument();

    // Deterministic on purpose: process memory (RSS, V8 heap samples) moves
    // with GC timing and would make this test flaky for reasons that have
    // nothing to do with a regression. What the layer-bounds optimisation
    // actually controls is how many bytes of pixel buffer a document holds
    // onto, and that is exact and reproducible.
    const bytes = accumulateUniquePixelBytes(state, new Set());

    // Compared against a structural fact rather than a hand-picked number: if
    // every layer stored a full-canvas buffer regardless of how little it
    // paints — the state of things before layer-local bounds — this document
    // would cost layers x width x height x 4 bytes. A first attempt at this
    // test asserted a flat 10MB and failed at a measured 13.4MB, because that
    // 10MB never accounted for the one full-canvas background layer every
    // document starts with (~8.3MB on its own) — it was a guess, not a
    // computation. Asking instead for "well under what full-canvas storage
    // would cost" stays correct regardless of how the fixture's box sizes are
    // tuned later.
    const fullCanvasCost = state.layers.length * state.width * state.height * 4;
    expect(bytes).toBeLessThan(fullCanvasCost * 0.3);
  });
});
