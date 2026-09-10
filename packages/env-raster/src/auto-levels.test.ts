import { describe, expect, it } from "vitest";
import { computeAutoLevels, defaultAutoLevelsOptions, type AutoLevelsOptions } from "./auto-levels";
import { applyAdjustment } from "./adjustments";

const W = 40, H = 40;

/** A flat-filled canvas plus a `paint` callback for carving out clusters, mirroring healing.test.ts's own fixture style. */
function canvas(fill: readonly [number, number, number]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let index = 0; index < pixels.length; index += 4) { pixels[index] = fill[0]; pixels[index + 1] = fill[1]; pixels[index + 2] = fill[2]; pixels[index + 3] = 255; }
  return pixels;
}

function paintBlock(pixels: Uint8ClampedArray, x0: number, y0: number, size: number, color: readonly [number, number, number]): void {
  for (let y = y0; y < y0 + size; y += 1) for (let x = x0; x < x0 + size; x += 1) {
    const index = (y * W + x) * 4;
    pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2];
  }
}

const options = (overrides: Partial<AutoLevelsOptions>): AutoLevelsOptions => ({ ...defaultAutoLevelsOptions, ...overrides });

describe("computeAutoLevels", () => {
  it("enhance monochromatic contrast: one clip point, applied identically to every channel", () => {
    // Every pixel sits inside [50,200] — nothing genuinely black or white.
    const pixels = canvas([125, 125, 125]);
    paintBlock(pixels, 0, 0, 10, [50, 50, 50]);
    paintBlock(pixels, 30, 30, 10, [200, 200, 200]);
    const result = computeAutoLevels(pixels, options({ model: "monochromaticContrast", shadowClip: 0, highlightClip: 0 }));
    expect(result.channels).toBeUndefined();
    expect(result.blackInput).toBeCloseTo(50, 0);
    expect(result.whiteInput).toBeCloseTo(200, 0);
  });

  it("enhance per channel contrast: each channel stretched against its own range, independently", () => {
    const pixels = canvas([128, 128, 128]);
    paintBlock(pixels, 0, 0, 10, [80, 20, 100]); // dark corner: R=80 G=20 B=100
    paintBlock(pixels, 30, 30, 10, [150, 220, 180]); // light corner: R=150 G=220 B=180
    const result = computeAutoLevels(pixels, options({ model: "perChannelContrast", shadowClip: 0, highlightClip: 0 }));
    expect(result.channels).toBeDefined();
    expect(result.channels!.red!.blackInput).toBeCloseTo(80, 0);
    expect(result.channels!.red!.whiteInput).toBeCloseTo(150, 0);
    expect(result.channels!.green!.blackInput).toBeCloseTo(20, 0);
    expect(result.channels!.green!.whiteInput).toBeCloseTo(220, 0);
    expect(result.channels!.blue!.blackInput).toBeCloseTo(100, 0);
    expect(result.channels!.blue!.whiteInput).toBeCloseTo(180, 0);
  });

  it("find dark & light colors: captures the real (colour-cast) average of each cluster, not just its luminance", () => {
    const pixels = canvas([128, 128, 128]);
    paintBlock(pixels, 0, 0, 10, [10, 10, 60]); // a dark corner tinted blue, not neutral black
    paintBlock(pixels, 30, 30, 10, [245, 245, 200]); // a light corner tinted yellow, not neutral white
    const result = computeAutoLevels(pixels, options({ model: "findDarkLightColors", shadowClip: 5, highlightClip: 5 }));
    // The blue cast on the dark side has to show up as a *higher* black point
    // on the blue channel than on red/green — otherwise the cast was lost.
    expect(result.channels!.blue!.blackInput).toBeGreaterThan(result.channels!.red!.blackInput);
    expect(result.channels!.blue!.blackInput).toBeCloseTo(60, 0);
    expect(result.channels!.red!.blackInput).toBeCloseTo(10, 0);
    // And the yellow cast on the light side as a *lower* white point on blue.
    expect(result.channels!.blue!.whiteInput).toBeLessThan(result.channels!.red!.whiteInput);
  });

  it("maps the found dark/light clusters onto custom target colours, not a hardcoded 0/255", () => {
    const pixels = canvas([128, 128, 128]);
    paintBlock(pixels, 0, 0, 10, [10, 10, 10]);
    paintBlock(pixels, 30, 30, 10, [245, 245, 245]);
    const result = computeAutoLevels(pixels, options({
      model: "findDarkLightColors", shadowClip: 5, highlightClip: 5,
      targetShadow: { r: 20, g: 20, b: 20, a: 255 }, targetHighlight: { r: 235, g: 235, b: 235, a: 255 },
    }));
    expect(result.channels!.red!.blackOutput).toBe(20);
    expect(result.channels!.red!.whiteOutput).toBe(235);
  });

  it("snapping neutral midtones pulls the bulk of the image toward the target midtone colour via gamma, not the endpoints", () => {
    // Midtone cluster is tinted green; endpoints are neutral, so only gamma should move.
    const pixels = canvas([120, 150, 120]);
    paintBlock(pixels, 0, 0, 8, [10, 10, 10]);
    paintBlock(pixels, 32, 32, 8, [245, 245, 245]);
    const withoutSnap = computeAutoLevels(pixels, options({ model: "findDarkLightColors", shadowClip: 8, highlightClip: 8, snapNeutralMidtones: false }));
    const withSnap = computeAutoLevels(pixels, options({ model: "findDarkLightColors", shadowClip: 8, highlightClip: 8, snapNeutralMidtones: true }));
    expect(withoutSnap.channels!.green!.gamma).toBe(1);
    // The green channel is brighter in the midtones, so pulling it toward
    // neutral needs a gamma below 1 (compresses green's own highlights down).
    expect(withSnap.channels!.green!.gamma).toBeLessThan(1);
    expect(withoutSnap.channels!.red!.blackInput).toBe(withSnap.channels!.red!.blackInput);
    expect(withoutSnap.channels!.red!.whiteInput).toBe(withSnap.channels!.red!.whiteInput);
  });

  it("a flat, uniform image degrades to the identity mapping rather than clipping past itself", () => {
    const pixels = canvas([128, 128, 128]);
    const result = computeAutoLevels(pixels, options({ model: "monochromaticContrast" }));
    expect(result.blackInput).toBe(0);
    expect(result.whiteInput).toBe(255);
  });

  it("the computed result actually changes the image when applied — not a dead-end object", () => {
    const pixels = canvas([128, 128, 128]);
    paintBlock(pixels, 0, 0, 10, [40, 40, 40]);
    paintBlock(pixels, 30, 30, 10, [210, 210, 210]);
    const result = computeAutoLevels(pixels.slice(), options({ model: "monochromaticContrast", shadowClip: 0, highlightClip: 0 }));
    const after = pixels.slice();
    applyAdjustment(after, result, 1);
    let changed = 0;
    for (let index = 0; index < after.length; index += 4) if (after[index] !== pixels[index]) changed += 1;
    expect(changed).toBeGreaterThan(0);
  });
});
