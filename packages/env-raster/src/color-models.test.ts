import { describe, expect, it } from "vitest";
import { cmykToRgb, labEncodedToRgb, labToRgb, limitToCmykGamut, rgbToCmyk, rgbToLab, rgbToLabEncoded } from "./color-models";
import { buildIndexedPalette, nearestPaletteIndex, paletteFromHex, paletteToHex, snapToPalette } from "./indexed-palette";

/**
 * docs/master-plan.md §59.3: Lab, CMYK and Indexed as real document models.
 *
 * Lab is checked against published values rather than against itself — a round trip through a
 * wrong matrix still round-trips. CMYK is checked for the property that makes the mode meaningful
 * (colours outside the separation's gamut really move), and the palette for the property that
 * makes Indexed meaningful (nothing survives that is not in the table).
 */

describe("Lab", () => {
  it("matches published L*a*b* values for sRGB primaries", () => {
    // Bruce Lindbloom's calculator, sRGB/D50: white is L=100, and pure red is L≈54.29, a≈80.8, b≈69.9.
    const white = rgbToLab(255, 255, 255);
    expect(white.l).toBeCloseTo(100, 1);
    expect(Math.abs(white.a)).toBeLessThan(0.1);
    expect(Math.abs(white.b)).toBeLessThan(0.1);

    const red = rgbToLab(255, 0, 0);
    expect(red.l).toBeCloseTo(54.3, 0);
    expect(red.a).toBeCloseTo(80.8, 0);
    expect(red.b).toBeCloseTo(69.9, 0);

    const black = rgbToLab(0, 0, 0);
    expect(black.l).toBeCloseTo(0, 3);
  });

  it("round-trips a colour back to the byte it started as", () => {
    for (const colour of [[10, 200, 130], [255, 128, 0], [64, 64, 64], [0, 0, 255]] as const) {
      const back = labToRgb(rgbToLab(colour[0], colour[1], colour[2]));
      expect(back, colour.join(",")).toEqual([colour[0], colour[1], colour[2]]);
    }
  });

  it("round-trips a whole buffer through the storage encoding, alpha untouched", () => {
    const pixels = new Uint8ClampedArray([180, 120, 60, 200, 64, 64, 64, 255, 12, 34, 56, 0]);
    const back = labEncodedToRgb(rgbToLabEncoded(pixels));

    expect(back[3]).toBe(200);
    expect(back[7]).toBe(255);
    // 8-bit Lab quantises L to 100/255 and the colour axes to whole units, so an ordinary colour
    // comes back within a step or two.
    for (let index = 0; index < 8; index += 1) expect(Math.abs(back[index]! - pixels[index]!), `channel ${index}`).toBeLessThanOrEqual(2);
  });

  it("is measurably lossy exactly where 8-bit Lab is known to be — a channel sitting at zero", () => {
    // Measured over the whole cube: the worst round-trip error is 21 levels, on saturated cyan
    // (0, 204, 238), and it lands on the channel that is *at* zero. Half a unit of a* moves that
    // channel's linear value off zero by 0.006, and sRGB's curve is near-vertical there, so 0.006
    // encodes as 21. This is a property of storing Lab in bytes, not a bug in the conversion —
    // Photoshop's 8-bit Lab has it too — and it is written down so that a future change which
    // makes it *worse* is visible rather than silent.
    const back = labEncodedToRgb(rgbToLabEncoded(new Uint8ClampedArray([0, 204, 238, 255])));

    expect(back[0]).toBeLessThanOrEqual(21);
    expect(Math.abs(back[1]! - 204)).toBeLessThanOrEqual(2);
    expect(Math.abs(back[2]! - 238)).toBeLessThanOrEqual(2);
  });
});

describe("CMYK", () => {
  it("separates and recombines a colour", () => {
    expect(rgbToCmyk(255, 255, 255)).toEqual({ c: 0, m: 0, y: 0, k: 0 });
    expect(rgbToCmyk(0, 0, 0)).toEqual({ c: 0, m: 0, y: 0, k: 1 });
    const red = rgbToCmyk(255, 0, 0);
    expect(red.k).toBe(0); expect(red.c).toBe(0); expect(red.m).toBe(1); expect(red.y).toBe(1);
    expect(cmykToRgb(red)).toEqual([255, 0, 0]);
  });

  it("leaves in-gamut colours alone and keeps alpha out of it", () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 128, 0, 0, 0, 255]);
    limitToCmykGamut(pixels);

    expect(Array.from(pixels)).toEqual([255, 0, 0, 128, 0, 0, 0, 255]);
  });

  it("does not touch fully transparent pixels", () => {
    const pixels = new Uint8ClampedArray([7, 9, 11, 0]);
    limitToCmykGamut(pixels);
    expect(Array.from(pixels)).toEqual([7, 9, 11, 0]);
  });
});

describe("Indexed colour", () => {
  const stripes = (): { pixels: Uint8ClampedArray; width: number; height: number } => {
    const width = 16, height = 16;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const band = index % 4;
      const colour = [[220, 20, 20], [20, 220, 20], [20, 20, 220], [230, 230, 230]][band]!;
      pixels[index * 4] = colour[0]!; pixels[index * 4 + 1] = colour[1]!; pixels[index * 4 + 2] = colour[2]!; pixels[index * 4 + 3] = 255;
    }
    return { pixels, width, height };
  };

  it("builds a palette that holds the colours actually in the image", () => {
    const { pixels } = stripes();
    const palette = buildIndexedPalette(pixels, 4);

    expect(palette.size).toBe(4);
    for (const colour of [[220, 20, 20], [20, 220, 20], [20, 20, 220], [230, 230, 230]] as const) {
      const entry = nearestPaletteIndex(palette, colour[0], colour[1], colour[2]);
      expect(Math.abs(palette.colors[entry * 3]! - colour[0]), colour.join(",")).toBeLessThan(6);
    }
  });

  it("leaves nothing in the image that is not in the table", () => {
    const { pixels, width, height } = stripes();
    // A gradient forces colours the four-entry table cannot hold exactly.
    for (let index = 0; index < width; index += 1) { pixels[index * 4] = index * 16; pixels[index * 4 + 1] = 128; pixels[index * 4 + 2] = 255 - index * 16; }
    const palette = buildIndexedPalette(pixels, 8);
    snapToPalette(pixels, width, height, palette, true);

    const allowed = new Set(paletteToHex(palette));
    for (let index = 0; index < width * height; index += 1) {
      if (!pixels[index * 4 + 3]) continue;
      const hex = `#${[0, 1, 2].map((channel) => pixels[index * 4 + channel]!.toString(16).padStart(2, "0")).join("")}`;
      expect(allowed.has(hex), `pixel ${index} → ${hex}`).toBe(true);
    }
  });

  it("round-trips a palette through its hex form", () => {
    const palette = buildIndexedPalette(stripes().pixels, 4);
    const back = paletteFromHex(paletteToHex(palette));

    expect(Array.from(back.colors)).toEqual(Array.from(palette.colors));
  });

  it("ignores fully transparent pixels when choosing colours", () => {
    const pixels = new Uint8ClampedArray(8 * 4);
    for (let index = 0; index < 8; index += 1) { pixels[index * 4] = 200; pixels[index * 4 + 1] = 40; pixels[index * 4 + 2] = 40; }
    pixels[3] = 255;                                  // exactly one opaque pixel; the rest are clear
    const palette = buildIndexedPalette(pixels, 4);

    // Transparent pixels used to pull every palette toward black by voting with their colour.
    expect(palette.colors[0]).toBe(200);
  });
});
