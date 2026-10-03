import { describe, expect, it } from "vitest";
import { applyRasterFilter } from "./filters";

/**
 * docs/master-plan.md §52 — `medianBlur` was rewritten from a per-pixel "collect the window into
 * an array, sort it, take the middle" (O((2r+1)²·log(2r+1)²) per pixel per channel, plus an array
 * allocation every pixel) into a sliding 256-bin histogram (Huang 1981 — the same algorithm GIMP's
 * `median-blur.c` and OpenCV's `medianBlur` use), because the naive version was measured hanging
 * past 45 seconds on a 4000×3000 document at radius 8 through the standalone Median dialog
 * (`apps/web/src/App.tsx`'s `runFilterPanelPreview`), not just being slow — the user-visible bug
 * this section calls "многие фильтры... тупит".
 *
 * `referenceMedianBlur` below is the *original* naive implementation, kept only here, as the
 * ground truth these tests hold the new one to byte-for-byte — CLAUDE.md §2's own discipline for
 * exactly this shape of change ("сравнивать с прежним результатом побайтово, не на глаз").
 */
function referenceMedianBlur(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const r = Math.max(1, Math.min(8, Math.round(radius)));
  const output = new Uint8ClampedArray(source.length);
  const samples: number[] = [];
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const outputIndex = (y * width + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      samples.length = 0;
      for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
        samples.push(source[(clampY(y + dy) * width + clampX(x + dx)) * 4 + channel]!);
      }
      samples.sort((left, right) => left - right);
      output[outputIndex + channel] = samples[samples.length >> 1]!;
    }
  }
  return output;
}

function randomFixture(width: number, height: number, seed: number): Uint8ClampedArray {
  let state = seed >>> 0;
  const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0xffffffff; };
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = Math.floor(next() * 256);
  return pixels;
}

describe("medianBlur (fast histogram version) matches the original naive implementation byte-for-byte", () => {
  it.each([1, 2, 3, 5, 8, 20])("radius %i on random noise", (radius) => {
    const width = 37, height = 29; // deliberately not a multiple of any window size, and small enough edges matter a lot
    const source = randomFixture(width, height, 12345 + radius);
    const fast = applyRasterFilter(source, width, height, "median", { radius });
    const reference = referenceMedianBlur(source, width, height, radius);
    expect([...fast]).toEqual([...reference]);
  });

  it("matches on a flat, fully transparent buffer (every window identical, edge clamping degenerate)", () => {
    const width = 20, height = 15;
    const source = new Uint8ClampedArray(width * height * 4);
    const fast = applyRasterFilter(source, width, height, "median", { radius: 8 });
    const reference = referenceMedianBlur(source, width, height, 8);
    expect([...fast]).toEqual([...reference]);
  });

  it("matches with radius larger than the image itself (every window entirely edge-clamped)", () => {
    const width = 5, height = 4;
    const source = randomFixture(width, height, 999);
    const fast = applyRasterFilter(source, width, height, "median", { radius: 8 });
    const reference = referenceMedianBlur(source, width, height, 8);
    expect([...fast]).toEqual([...reference]);
  });

  it("matches on a 1-pixel-tall strip (degenerate vertical window)", () => {
    const width = 50, height = 1;
    const source = randomFixture(width, height, 777);
    const fast = applyRasterFilter(source, width, height, "median", { radius: 4 });
    const reference = referenceMedianBlur(source, width, height, 4);
    expect([...fast]).toEqual([...reference]);
  });
});

describe("medianBlur stays fast on a large document (the actual regression)", () => {
  it("radius 8 costs barely more than radius 2 — the sliding histogram's whole point", () => {
    const width = 1200, height = 900;
    const source = randomFixture(width, height, 42);
    const fastestAt = (radius: number): number => {
      let best = Infinity;
      for (let sample = 0; sample < 2; sample += 1) {
        const started = performance.now();
        applyRasterFilter(source, width, height, "median", { radius });
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };

    const small = fastestAt(2), large = fastestAt(8);

    // This replaced a wall-clock floor ("under 1000ms at radius 8"), and the reason is worth
    // keeping: that number was calibrated on a faster machine than the one this is developed on,
    // where the same unchanged code measures 1012ms, 958ms, 1185ms, 1060ms run after run. A test
    // whose verdict is decided by which side of the line the scheduler happens to drop it on
    // reports the machine, not the code — and it invited exactly the wrong conclusion once
    // already: bisecting the "regression" it seemed to show found today's median to be the
    // *fastest* of every commit since that bound was written.
    //
    // What the bound was actually protecting is a shape, not a millisecond count. The naive
    // implementation it replaced collects and sorts the whole (2r+1)² window per pixel, so its
    // cost grows with the square of the radius — (17/5)² ≈ 11.6 in theory, and 19.0 measured on
    // `referenceMedianBlur` above, since a longer array also sorts slower per element. Huang's
    // sliding histogram only slides columns in and out, so the same comparison measures 1.4-2.1
    // here. Both ends of that are measurements, not estimates, and a ratio of two timings taken
    // seconds apart on one machine says the same thing on a slow machine as on a fast one. 5x
    // sits with wide margin on both sides: well clear of the noise, far below the naive shape.
    expect(large / small).toBeLessThan(5);

    // A second guard for the regression a ratio cannot see — one that makes every radius equally
    // slower (a per-pixel allocation, say). Deliberately loose, because the ratio above is the
    // real net: this one only has to notice a return to the tens of seconds the naive version
    // took at this size, and anything near that trips it many times over.
    expect(large).toBeLessThan(5000);
  }, 60000);
});
