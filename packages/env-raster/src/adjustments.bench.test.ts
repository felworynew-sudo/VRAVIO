import { describe, expect, it } from "vitest";
import { applyAdjustment } from "./adjustments";
import type { RasterAdjustment } from "./types";

/**
 * Adjustment layers apply once per tile every time the compositor touches
 * that tile (render.ts's own `applyAdjustment(output, layer.adjustment, …)`,
 * inside the per-layer loop) — a slow adjustment is not a one-time cost paid
 * on commit, it is paid on every paint stroke, every scrub, every frame a
 * document with that layer visible repaints. Measured, not guessed
 * (performance.bench.test.ts's own convention): threshold is 6× the fastest
 * of 5 samples on this machine.
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

/** A full opaque RGBA tile with real per-pixel variation, the shape
 *  applyAdjustment actually receives from render.ts's tiled compositor. */
function tile(size: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    const i = index / 4, x = i % size, y = Math.floor(i / size);
    pixels[index] = (x * 3 + y) % 255; pixels[index + 1] = (y * 5 + x) % 255; pixels[index + 2] = (x + y) % 255; pixels[index + 3] = 255;
  }
  return pixels;
}

const TILE = 512; // render.ts's own compositor tiles at this scale (see subdivideAbove's comment).

// `RasterAdjustment` splits into two cost tiers, both intentional
// (adjustments.ts's own comment on `buildPointLut`): a point transform whose
// output depends only on that pixel's own channel reduces to a 256-entry
// table built once — levels, curves, brightness/contrast among them — while
// anything that genuinely mixes channels (hue/saturation's HSL round-trip,
// the channel mixer's weighted sum) has no such reduction and stays
// per-pixel, the same tradeoff GIMP's own adjustment operations make for the
// same reason. The threshold below is per case, not shared, because the two
// tiers are not supposed to cost the same.
const cases: readonly [string, RasterAdjustment, number][] = [
  ["levels (LUT path)", { kind: "levels", blackInput: 10, gamma: 1.2, whiteInput: 240, blackOutput: 0, whiteOutput: 255 }, 3],
  ["curves (LUT path)", { kind: "curves", points: [{ x: 0, y: 0 }, { x: 90, y: 60 }, { x: 180, y: 210 }, { x: 255, y: 255 }] }, 3.3],
  ["brightness/contrast (LUT path)", { kind: "brightnessContrast", brightness: 20, contrast: 15 }, 3.3],
  ["hue/saturation (per-pixel path)", { kind: "hueSaturation", hue: 30, saturation: 20, lightness: -10 }, 37.6],
  ["channel mixer (per-pixel path)", { kind: "channelMixer", outputChannel: "red", monochrome: false, red: [120, 40, -20, 0], green: [30, 100, -10, 0], blue: [10, 10, 100, 0] }, 20.5],
];

describe("adjustment layer performance floor", () => {
  for (const [label, adjustment, measuredMs] of cases) {
    it(`applies ${label} to a ${TILE}×${TILE} tile`, () => {
      const pixels = tile(TILE);
      const elapsed = fastestOf(() => applyAdjustment(pixels.slice(), adjustment, 1));
      expect(elapsed).toBeLessThan(measuredMs * THRESHOLD_MULTIPLIER);
    });
  }
});
