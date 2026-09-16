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
  it("radius 8 on a 1200x900 noisy document finishes well under a second", () => {
    const width = 1200, height = 900;
    const source = randomFixture(width, height, 42);
    const started = performance.now();
    applyRasterFilter(source, width, height, "median", { radius: 8 });
    const elapsed = performance.now() - started;
    // The naive implementation this replaces took tens of seconds at this size and radius —
    // generously bounded at 1s (a loaded CI/dev machine, not a tight per-frame budget) to catch a
    // future regression back toward that shape without being a flaky near-miss on a busy machine.
    expect(elapsed).toBeLessThan(1000);
  });
});
