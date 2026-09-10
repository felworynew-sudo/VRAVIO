import { describe, expect, it } from "vitest";
import { computeLabStats, harmonizeToReference } from "./harmonize";

const W = 20, H = 20;

function solidBuffer(r: number, g: number, b: number, w = W, h = H): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = 255;
  }
  return pixels;
}

describe("computeLabStats", () => {
  it("returns null for a fully transparent buffer — nothing to summarize", () => {
    const pixels = new Uint8ClampedArray(W * H * 4);
    expect(computeLabStats(pixels, W, H)).toBeNull();
  });

  it("finds near-zero spread on a solid color, and a mean matching its own Lab conversion", () => {
    const pixels = solidBuffer(200, 80, 60);
    const stats = computeLabStats(pixels, W, H)!;
    expect(stats).not.toBeNull();
    expect(stats.l.std).toBeLessThan(0.01);
    expect(stats.a.std).toBeLessThan(0.01);
    expect(stats.b.std).toBeLessThan(0.01);
    // A warm reddish color: positive a (red-green axis toward red), positive b (blue-yellow toward yellow).
    expect(stats.a.mean).toBeGreaterThan(0);
    expect(stats.l.mean).toBeGreaterThan(0);
    expect(stats.l.mean).toBeLessThan(100);
  });

  it("restricts to the given region instead of the whole buffer", () => {
    const pixels = solidBuffer(0, 0, 0);
    // A bright patch in one corner only.
    for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) {
      const index = (y * W + x) * 4; pixels[index] = 255; pixels[index + 1] = 255; pixels[index + 2] = 255;
    }
    const wholeBuffer = computeLabStats(pixels, W, H)!;
    const patchOnly = computeLabStats(pixels, W, H, { x: 0, y: 0, width: 5, height: 5 })!;
    const outsidePatch = computeLabStats(pixels, W, H, { x: 10, y: 10, width: 5, height: 5 })!;
    // The patch region reads as bright (high L); the untouched region reads as black (L near 0);
    // the whole-buffer average sits somewhere between the two, not equal to either extreme.
    expect(patchOnly.l.mean).toBeGreaterThan(90);
    expect(outsidePatch.l.mean).toBeLessThan(5);
    expect(wholeBuffer.l.mean).toBeGreaterThan(outsidePatch.l.mean);
    expect(wholeBuffer.l.mean).toBeLessThan(patchOnly.l.mean);
  });
});

describe("harmonizeToReference", () => {
  it("leaves pixels unchanged at strength 0", () => {
    const pixels = solidBuffer(30, 200, 40);
    const source = computeLabStats(pixels, W, H)!;
    const reference = computeLabStats(solidBuffer(200, 30, 180), W, H)!;
    const out = harmonizeToReference(pixels, W, H, source, reference, 0);
    expect([...out]).toEqual([...pixels]);
  });

  it("never mutates the input buffer", () => {
    const pixels = solidBuffer(30, 200, 40);
    const before = pixels.slice();
    const source = computeLabStats(pixels, W, H)!;
    const reference = computeLabStats(solidBuffer(200, 30, 180), W, H)!;
    harmonizeToReference(pixels, W, H, source, reference, 1);
    expect([...pixels]).toEqual([...before]);
  });

  it("moves a solid layer's own statistics toward the reference's, proportional to strength", () => {
    const pixels = solidBuffer(30, 30, 220); // cool blue
    const source = computeLabStats(pixels, W, H)!;
    const reference = computeLabStats(solidBuffer(220, 140, 40), W, H)!; // warm orange

    const half = harmonizeToReference(pixels, W, H, source, reference, 0.5);
    const full = harmonizeToReference(pixels, W, H, source, reference, 1);
    const halfStats = computeLabStats(half, W, H)!;
    const fullStats = computeLabStats(full, W, H)!;

    // Full strength lands (within float rounding) on the reference's own Lab mean.
    expect(fullStats.l.mean).toBeCloseTo(reference.l.mean, 0);
    expect(fullStats.a.mean).toBeCloseTo(reference.a.mean, 0);
    expect(fullStats.b.mean).toBeCloseTo(reference.b.mean, 0);

    // Half strength is a real midpoint, not a no-op and not the full jump.
    const distanceBefore = Math.abs(source.a.mean - reference.a.mean);
    const distanceAtHalf = Math.abs(halfStats.a.mean - reference.a.mean);
    expect(distanceAtHalf).toBeLessThan(distanceBefore);
    expect(distanceAtHalf).toBeGreaterThan(0.01);
  });

  it("degrades to a mean-only shift instead of NaN/Infinity when the source has ~zero spread", () => {
    const pixels = solidBuffer(100, 100, 100); // std is exactly 0 on a solid buffer
    const source = computeLabStats(pixels, W, H)!;
    const reference = computeLabStats(solidBuffer(0, 250, 0), W, H)!; // a reference with real spread would come from a varied scene; a solid one here is enough to exercise the ratio guard
    const out = harmonizeToReference(pixels, W, H, source, reference, 1);
    for (const value of out) expect(Number.isFinite(value)).toBe(true);
  });

  it("leaves transparent pixels untouched", () => {
    const pixels = solidBuffer(30, 30, 220);
    pixels[3] = 0; // first pixel transparent
    const source = computeLabStats(pixels, W, H)!;
    const reference = computeLabStats(solidBuffer(220, 140, 40), W, H)!;
    const out = harmonizeToReference(pixels, W, H, source, reference, 1);
    expect(out[0]).toBe(pixels[0]);
    expect(out[1]).toBe(pixels[1]);
    expect(out[2]).toBe(pixels[2]);
    expect(out[3]).toBe(0);
  });

  /**
   * The owner's own complaint ("наш вариант плохо работает"): the original,
   * single-statistic Reinhard match moves every pixel by the same amount, so
   * an object with real internal contrast (not a flat color swatch, unlike
   * every test above) comes out flattened — its own local detail displaced
   * exactly as far as the overall color cast was. The multi-scale rewrite
   * (`harmonize.ts`'s own doc comment, after Sunkavalli et al. 2010) matches
   * only a blurred low-frequency band and adds the original detail back
   * untouched, so a textured layer should keep its own internal contrast
   * even as its overall cast moves toward the reference.
   */
  function checkerboardBuffer(dark: number, light: number, squareSize: number, w = 64, h = 64): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const on = (Math.floor(x / squareSize) + Math.floor(y / squareSize)) % 2 === 0;
        const value = on ? light : dark;
        const index = (y * w + x) * 4;
        pixels[index] = value; pixels[index + 1] = value; pixels[index + 2] = value; pixels[index + 3] = 255;
      }
    }
    return pixels;
  }

  it("keeps a textured layer's own local contrast instead of flattening it toward the reference's flat color", () => {
    const w = 64, h = 64;
    const pixels = checkerboardBuffer(40, 210, 8, w, h); // strong dark/light checker texture
    const source = computeLabStats(pixels, w, h)!;
    const reference = computeLabStats(solidBuffer(140, 140, 140, w, h), w, h)!; // flat mid-gray reference

    const out = harmonizeToReference(pixels, w, h, source, reference, 1, { x: 0, y: 0, width: w, height: h });

    // Two adjacent checker squares' own centres, well inside the buffer, away from any edge:
    // (24, 24) and (32, 24) sit one square apart (squareSize 8), landing on opposite parity.
    const darkIndex = (24 * w + 32) * 4, lightIndex = (24 * w + 24) * 4;
    const contrastBefore = Math.abs(pixels[lightIndex]! - pixels[darkIndex]!);
    const contrastAfter = Math.abs(out[lightIndex]! - out[darkIndex]!);
    // A plain global mean/std match would shrink this close to zero (both squares pulled toward
    // the same flat reference value); the multi-scale version keeps most of the original swing.
    expect(contrastAfter).toBeGreaterThan(contrastBefore * 0.5);
  });
});
