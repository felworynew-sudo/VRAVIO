import { describe, expect, it } from "vitest";
import { applyRasterFilter } from "./filters";
import { applyRasterFilterDeep, filterRunsAtDepth, DEEP_FILTER_IDS } from "./filters-deep";

/**
 * docs/master-plan.md §59.2b. Two things are checked, and the first matters most: a depth-aware
 * filter must reproduce the 8-bit catalogue's own answer when it is handed 8-bit pixels. Otherwise
 * a document would look different depending on its depth, which is a worse failure than the
 * banding this slice set out to remove.
 */

const ramp = (width: number, height: number): Uint8ClampedArray => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    pixels[index] = (x * 7) % 256; pixels[index + 1] = (y * 11) % 256; pixels[index + 2] = (x + y) % 256; pixels[index + 3] = 255;
  }
  return pixels;
};

const toSixteen = (pixels: Uint8ClampedArray): Uint16Array => {
  const deep = new Uint16Array(pixels.length);
  for (let index = 0; index < pixels.length; index += 1) deep[index] = pixels[index]! * 257;
  return deep;
};

describe("depth-aware filters", () => {
  const width = 24, height = 16;

  it("matches the 8-bit catalogue on 8-bit pixels, for every filter that claims depth support", () => {
    for (const id of DEEP_FILTER_IDS) {
      const source = ramp(width, height);
      const eight = applyRasterFilter(source.slice(), width, height, id);
      const deep = applyRasterFilterDeep(source.slice(), width, height, id);
      let worst = 0;
      for (let index = 0; index < eight.length; index += 1) worst = Math.max(worst, Math.abs(eight[index]! - deep[index]!));
      // One level of tolerance, except for Gaussian Blur, where the 8-bit implementation
      // accumulates its vertical pass *into a `Uint8ClampedArray`* — every partial sum is rounded
      // to a whole byte before the next weight is added, which costs it up to two levels against
      // an honest float accumulation. The deep path is the more accurate of the two; the 8-bit one
      // is left as it is because its output is pinned byte-for-byte by other tests, and changing
      // it here would be a silent change to every existing document's blur.
      expect(worst, `${id} differs by ${worst}`).toBeLessThanOrEqual(id === "gaussian_blur" ? 2 : 1);
    }
  });

  it("keeps far more levels than eight bits through a blur of a gradient", () => {
    // A 256-wide gradient blurred at 8 bits collapses onto at most 256 values by construction; at
    // 16 bits the averages land between them, which is the banding this removes.
    const gradientWidth = 256;
    const source = new Uint8ClampedArray(gradientWidth * 4);
    for (let x = 0; x < gradientWidth; x += 1) { source[x * 4] = x; source[x * 4 + 1] = x; source[x * 4 + 2] = x; source[x * 4 + 3] = 255; }
    const deep = applyRasterFilterDeep(toSixteen(source), gradientWidth, 1, "gaussian_blur", { radius: 8 });

    const levels = new Set<number>();
    for (let x = 0; x < gradientWidth; x += 1) levels.add(deep[x * 4]!);
    expect(levels.size).toBeGreaterThan(200);
    // And the values are genuinely between the 8-bit steps, not multiples of 257.
    let offGrid = 0;
    for (let x = 0; x < gradientWidth; x += 1) if (deep[x * 4]! % 257 !== 0) offGrid += 1;
    expect(offGrid).toBeGreaterThan(100);
  });

  it("returns the buffer kind it was given", () => {
    expect(applyRasterFilterDeep(new Uint16Array(4 * 4), 2, 2, "invert")).toBeInstanceOf(Uint16Array);
    expect(applyRasterFilterDeep(new Float32Array(4 * 4), 2, 2, "invert")).toBeInstanceOf(Float32Array);
    expect(applyRasterFilterDeep(new Uint8ClampedArray(4 * 4), 2, 2, "invert")).toBeInstanceOf(Uint8ClampedArray);
  });

  it("refuses a filter it has no depth implementation for instead of doing something else", () => {
    expect(filterRunsAtDepth("oil_paint")).toBe(false);
    expect(() => applyRasterFilterDeep(new Uint16Array(16), 2, 2, "oil_paint")).toThrow(/no depth-aware implementation/);
  });
});
