import { describe, expect, it } from "vitest";
import { createRectangleSelection } from "./selection";
import { patchFromSelection } from "./patch";

/**
 * The patch tool re-runs `patchFromSelection` once per pointer-move while the
 * user drags — that is the live preview the owner explicitly asked to keep
 * fast ("должно все летать. как и в штампе мы динамически видим предпросмотр
 * с источника"). A slow membrane solve here is not a background job that can
 * take its time; it is the frame the drag is waiting on.
 *
 * Threshold and fixture follow performance.bench.test.ts's own convention:
 * measured on this machine, not guessed, with a loose multiplier so a slower
 * box or a cold JIT does not fail the suite on noise alone. If this goes red,
 * the fix is to speed the solve up (or shrink what it touches), not to raise
 * the number.
 */
const THRESHOLD_MULTIPLIER = 6;

function fastestOf(fn: () => void, samples = 5): number {
  let best = Infinity;
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** A believable full-size canvas with real low-frequency variation, so the
 *  membrane has real work to do rather than converging on a flat field. */
function documentCanvas(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    const value = 60 + Math.sin(x / 37) * 40 + Math.cos(y / 29) * 40 + ((x + y) % 23);
    pixels[index] = value; pixels[index + 1] = value * 0.8; pixels[index + 2] = value * 1.1; pixels[index + 3] = 255;
  }
  return pixels;
}

describe("patch tool performance floor", () => {
  const width = 1920, height = 1080;

  it("solves one full-quality drag frame over a large (300x300) repair in source mode", () => {
    const pixels = documentCanvas(width, height);
    const selection = createRectangleSelection(width, height, 400, 300, 700, 600);
    const elapsed = fastestOf(() => {
      patchFromSelection(pixels.slice(), width, height, selection.mask, selection.bounds, 220, 40, 1, "source", 0);
    });
    // Measured on this fixture: ~112ms. This is the commit-on-release cost
    // (sweepScale 1, its default) — patch.tsx's own live-drag frames use a
    // cheaper sweepScale, covered separately below, because this number is
    // too slow to run on every pointer move and still feel like a drag.
    expect(elapsed).toBeLessThan(112 * THRESHOLD_MULTIPLIER);
  });

  it("solves one drag frame in destination mode at the same cost as source mode", () => {
    // The destOriginX/Y shift (patch.ts) moves where the region is anchored,
    // not how much of it there is — this should cost the same as source mode,
    // not scan the canvas looking for where the shifted rectangle landed.
    const pixels = documentCanvas(width, height);
    const selection = createRectangleSelection(width, height, 400, 300, 700, 600);
    const elapsed = fastestOf(() => {
      patchFromSelection(pixels.slice(), width, height, selection.mask, selection.bounds, 220, 40, 1, "destination", 0);
    });
    // Measured on this fixture: ~115ms, same order as source mode above.
    expect(elapsed).toBeLessThan(115 * THRESHOLD_MULTIPLIER);
  });

  it("stays proportional to the selection, not the canvas, on a small repair", () => {
    const pixels = documentCanvas(width, height);
    const selection = createRectangleSelection(width, height, 900, 500, 940, 540);
    const elapsed = fastestOf(() => {
      patchFromSelection(pixels.slice(), width, height, selection.mask, selection.bounds, 15, -15, 1, "source", 0);
    });
    // Measured on this fixture: ~5ms — a full-canvas floor here would mean
    // the region rectangle stopped shrinking to the selection somewhere.
    expect(elapsed).toBeLessThan(5 * THRESHOLD_MULTIPLIER);
  });

  it("feathering a large repair stays within the same order of magnitude", () => {
    const pixels = documentCanvas(width, height);
    const selection = createRectangleSelection(width, height, 400, 300, 700, 600);
    const elapsed = fastestOf(() => {
      patchFromSelection(pixels.slice(), width, height, selection.mask, selection.bounds, 220, 40, 1, "source", 40);
    });
    // Measured on this fixture: ~162ms. Feathering a 300×300 repair by 40px
    // also grows the padded region the membrane solves over (the Dirichlet
    // ring has to widen with the feather radius — patch.ts's own margin), so
    // this is slower than the unfeathered case above by more than a rounding
    // error; it is not slower by orders of magnitude the way it was before
    // `boxBlur` (selection.ts) became a sliding window instead of a per-pixel
    // nearest-empty-cell search — that version measured ~2000ms here.
    expect(elapsed).toBeLessThan(162 * THRESHOLD_MULTIPLIER);
  });

  it("a live-drag preview solve is markedly cheaper than the commit-quality one", () => {
    // patch.tsx's own live-drag frames pass a lower sweepScale
    // (solveHealMembrane, heal_membrane.ts, via patchFromSelection's own last
    // argument) than the commit on release does. Measured on this fixture, at
    // the same 300×300 + 40px-feather repair as the test above: ~162ms at
    // full quality down to ~66ms in preview — the number that actually gates
    // how a drag feels, not the full-quality figure.
    const pixels = documentCanvas(width, height);
    const selection = createRectangleSelection(width, height, 400, 300, 700, 600);
    const full = fastestOf(() => {
      patchFromSelection(pixels.slice(), width, height, selection.mask, selection.bounds, 220, 40, 1, "source", 40, 1);
    });
    const preview = fastestOf(() => {
      patchFromSelection(pixels.slice(), width, height, selection.mask, selection.bounds, 220, 40, 1, "source", 40, 0.3);
    });
    expect(preview).toBeLessThan(full * 0.7);
  });
});
