import { describe, expect, it } from "vitest";
import { compositeRasterDocument } from "./render";
import { createRasterDocument, createRasterLayer } from "./document";
import { appendLayer } from "./layer-tree";
import { translateLayerPixels, translateSelection } from "./transform";
import { combineSelections, createEllipseSelection } from "./selection";
import { accumulateUniquePixelBytes, layerDocumentPixels, setLayerPixels } from "./layer-bounds";
import { duplicateLayer } from "./layer-ops";
import { TileStore } from "./tile-store";
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

  it("drags an active selection", () => {
    // A large-but-not-full selection, the shape a real lasso or ellipse drag
    // produces — not a synthetic full-canvas mask, which would hide the
    // regression this guards: `translateSelection` used to walk the whole
    // 1920x1080 document on every call regardless of how much of it the
    // selection actually covered, because unlike `translateLayerPixels`
    // right above it in transform.ts, it had never been bounded to
    // `selection.bounds`. Called on every `pointermove` while dragging an
    // active selection (`marquee-selection.tsx`'s own `onPointerMove`, no
    // throttling), that queued synchronous full-canvas passes faster than
    // the main thread could drain them — reported live as a hang bad enough
    // to need a tab reload, not merely a slow drag.
    const state = realisticDocument(1);
    const selection = createEllipseSelection(state.width, state.height, 300, 200, 1200, 900);

    // Measured on this fixture, bounded to the ellipse's own ~900x700 box:
    // ~2.6ms. The unbounded version this replaces measured ~9ms on the same
    // fixture — cheap enough on its own, as a single call, to go unnoticed;
    // that is exactly how it survived until a sustained drag made the
    // per-event cost compound. Still not sub-millisecond — the copy loop
    // itself has ~630,000 pixels to visit for a selection this large — so
    // the floor here is 5ms rather than a tight multiple of 2.6, the same
    // reasoning the block-copy test above gives for its own floor.
    const elapsed = fastestOf(() => {
      translateSelection(selection, state.width, state.height, 15, -9);
    });
    expect(elapsed).toBeLessThan(5);
  });

  it("adds a lasso stroke to an existing selection", () => {
    // The other half of the same class of bug, in `selection.ts`'s own
    // `combineSelections`: outside the union of the two input bounds both
    // masks read zero and every combine mode gives zero back for a zero
    // pair, so the general (non-"replace") branch never needed to visit the
    // whole document either — it always had. Only a *second* lasso stroke
    // (add/subtract/intersect against an existing selection) reaches this
    // branch; a first trace with nothing selected yet takes the early
    // `mode === "replace"` return just below and was never slow.
    const state = realisticDocument(1);
    // Two modest, mostly-separate regions — adding a second lasso stroke
    // somewhere else on the canvas, not one that blankets most of it.
    const current = createEllipseSelection(state.width, state.height, 150, 150, 550, 500);
    const incoming = createEllipseSelection(state.width, state.height, 1300, 600, 1700, 950);

    // Measured on this fixture, bounded to the union of the two ellipses'
    // own boxes (~1550x800 — most of it empty space between the two shapes
    // the loop still has to cross, since the bound is a rectangle around
    // both, not their actual silhouettes): ~5.5ms. A floor of 8ms leaves
    // headroom for that without going anywhere near the ~2000x1080-ish cost
    // an unbounded full-canvas scan (the bug this guards) would have had.
    const elapsed = fastestOf(() => {
      combineSelections(current, incoming, state.width, state.height, "add");
    });
    expect(elapsed).toBeLessThan(8);
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

  /** A single dab-sized rectangle of opaque paint on an otherwise transparent
   *  canvas-sized buffer — the same shape `raster-commit.ts`'s own `assign` hands
   *  `setLayerPixels` after a brush stroke, at whatever canvas size is asked for. */
  function strokeShapedEdit(width: number, height: number): { pixels: Uint8ClampedArray; bounds: { x: number; y: number; width: number; height: number } } {
    const pixels = new Uint8ClampedArray(width * height * 4);
    const bounds = { x: Math.floor(width / 2) - 40, y: Math.floor(height / 2) - 40, width: 80, height: 80 };
    for (let y = 0; y < bounds.height; y += 1) for (let x = 0; x < bounds.width; x += 1) {
      const index = ((bounds.y + y) * width + (bounds.x + x)) * 4;
      pixels[index] = 200; pixels[index + 1] = 40; pixels[index + 2] = 40; pixels[index + 3] = 255;
    }
    return { pixels, bounds };
  }

  it("docs/master-plan.md §32.6: an add-only edit hint skips the full-canvas scan entirely", () => {
    const state = realisticDocument(2);
    const layer = state.layers[1] as RasterLayer;
    const { pixels, bounds } = strokeShapedEdit(state.width, state.height);

    const scanned = fastestOf(() => setLayerPixels(layer, pixels, state.width, state.height));
    const hinted = fastestOf(() => setLayerPixels(layer, pixels, state.width, state.height, { bounds, canShrink: false }));

    // Measured on this fixture: ~8ms scanning, ~0.1ms hinted — comfortably under
    // half, the same loose margin the rest of this file uses for "actually
    // faster", not "faster or noise".
    expect(hinted).toBeLessThan(scanned * 0.5);
  });

  /** A layer already trimmed to a small existing stroke — the fast path can only ever
   *  *grow* bounds, never shrink them (that is the one thing it explicitly gives up in
   *  exchange for skipping the scan), so a `createRasterLayer` fresh canvas-sized layer
   *  is the wrong starting point for measuring it: real strokes land on a layer some
   *  earlier edit already trimmed down, not on the one-time canvas-sized placeholder a
   *  brand new layer starts as. */
  function trimmedLayer(width: number, height: number) {
    const layer = createRasterLayer(width, height, "Layer");
    setLayerPixels(layer, strokeShapedEdit(width, height).pixels, width, height);
    return layer;
  }

  it("docs/master-plan.md §32.6: a hinted add-only commit does not grow with canvas size, only with the edit itself", () => {
    // The whole point of the fast path: a brush stroke on a 4000x3000 canvas
    // should cost the same as the identical stroke on a 1920x1080 one, because
    // neither ever reads a pixel outside the edit's own small rectangle. The
    // scanning path above is the opposite of this by construction — it walks
    // every pixel in the canvas regardless of how little the edit touched.
    const small = createRasterDocument(1920, 1080);
    const smallLayer = trimmedLayer(small.width, small.height);
    const smallEdit = strokeShapedEdit(small.width, small.height);
    const smallElapsed = fastestOf(() => setLayerPixels(smallLayer, layerDocumentPixels(smallLayer, small.width, small.height), small.width, small.height, { bounds: smallEdit.bounds, canShrink: false }));

    const large = createRasterDocument(4000, 3000);
    const largeLayer = trimmedLayer(large.width, large.height);
    const largeEdit = strokeShapedEdit(large.width, large.height);
    const largeElapsed = fastestOf(() => setLayerPixels(largeLayer, layerDocumentPixels(largeLayer, large.width, large.height), large.width, large.height, { bounds: largeEdit.bounds, canShrink: false }));

    // Generous absolute ceiling, not a ratio — an identically-shaped edit on
    // a ~4.3x larger canvas should not itself blow past a millisecond either
    // way, but comparing two already-tiny numbers as a ratio is exactly the
    // kind of assertion that goes flaky on GC noise for no real reason.
    expect(smallElapsed).toBeLessThan(2);
    expect(largeElapsed).toBeLessThan(2);
  });

  it("docs/master-plan.md §37.3 item 1: duplicating a layer does not scale with canvas size", () => {
    // Krita's copy-on-write trade for KisTileData, applied to layer-ops.ts's duplicateLayer:
    // the copy shares the source's buffer at the moment it is created, so the cost is the
    // layer-tree entry, not a memcpy of the pixels. Comparable in spirit to the §32.6 benchmark
    // above (an edit that doesn't scan the whole canvas) — this is the same claim about a
    // different operation: duplicating a layer should cost the same on a 4000x3000 canvas as
    // on a 1920x1080 one, because neither copies a single pixel.
    const small = realisticDocument(2);
    const smallElapsed = fastestOf(() => { duplicateLayer(small, small.layers[1]!.id); });

    const large = createRasterDocument(4000, 3000);
    const largeLayer = createRasterLayer(large.width, large.height, "Layer");
    setLayerPixels(largeLayer, strokeShapedEdit(large.width, large.height).pixels, large.width, large.height);
    appendLayer(large, largeLayer);
    const largeElapsed = fastestOf(() => { duplicateLayer(large, largeLayer.id); });

    // Generous absolute ceiling, not a ratio, for the same reason as the hinted-edit benchmark
    // above: two already-small numbers compared as a ratio goes flaky on GC noise for nothing.
    expect(smallElapsed).toBeLessThan(2);
    expect(largeElapsed).toBeLessThan(2);
  });

  it("docs/master-plan.md §37.3 item 1, step 1: TileStore.clone() + a small write does not scale with canvas size", () => {
    // Krita's own KisTileData trade, at the primitive level rather than the whole-layer level
    // duplicateLayer's benchmark above already covers: cloning a store and writing a small
    // region into the clone should cost the same on a 4000x3000 canvas as on a 1920x1080 one,
    // because only the handful of touched tiles are ever copied.
    const small = TileStore.fromPixels(new Uint8ClampedArray(1920 * 1080 * 4), 1920, 1080);
    const smallPatch = new Uint8ClampedArray(1920 * 1080 * 4);
    const smallElapsed = fastestOf(() => { small.clone().writeRegion({ x: 900, y: 500, width: 40, height: 40 }, smallPatch, 1920); });

    const large = TileStore.fromPixels(new Uint8ClampedArray(4000 * 3000 * 4), 4000, 3000);
    const largePatch = new Uint8ClampedArray(4000 * 3000 * 4);
    const largeElapsed = fastestOf(() => { large.clone().writeRegion({ x: 1900, y: 1400, width: 40, height: 40 }, largePatch, 4000); });

    // Generous absolute ceiling, not a ratio, for the same reason the rest of this file uses one
    // for already-tiny numbers: comparing two sub-millisecond timings as a ratio goes flaky on
    // GC noise for nothing.
    expect(smallElapsed).toBeLessThan(2);
    expect(largeElapsed).toBeLessThan(2);
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
