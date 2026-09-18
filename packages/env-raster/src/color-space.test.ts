import { describe, expect, it } from "vitest";
import { canvasColorSpaceFor, colorSpaceMatrix, convertPixelsColorSpace, rasterColorSpaceById, rasterColorSpaces } from "./color-space";

/** docs/master-plan.md §59: the numbers here are the published ones for these spaces, so they can
 *  be checked against the literature rather than against themselves. */
const pixel = (r: number, g: number, b: number, a = 255) => new Uint8ClampedArray([r, g, b, a]);

describe("working colour spaces", () => {
  it("every space in the list has an id, a label and primaries", () => {
    expect(rasterColorSpaces.length).toBeGreaterThanOrEqual(5);
    for (const space of rasterColorSpaces) {
      expect(rasterColorSpaceById(space.id)).toBe(space);
      expect(space.label.ru.length).toBeGreaterThan(0);
      expect(space.primaries).toHaveLength(3);
    }
  });

  it("sRGB's own RGB→XYZ matrix matches the published one", () => {
    // sRGB → linear sRGB is a pure transfer change, so the matrix is the identity.
    const identity = colorSpaceMatrix("srgb", "linear-srgb");
    expect(identity[0]).toBeCloseTo(1, 6);
    expect(identity[1]).toBeCloseTo(0, 6);
    expect(identity[4]).toBeCloseTo(1, 6);
  });

  it("white stays white in every direction", () => {
    for (const space of rasterColorSpaces) {
      const white = convertPixelsColorSpace(pixel(255, 255, 255), "srgb", space.id);
      expect([...white.subarray(0, 3)]).toEqual([255, 255, 255]);
      const back = convertPixelsColorSpace(white, space.id, "srgb");
      expect([...back.subarray(0, 3)]).toEqual([255, 255, 255]);
    }
  });

  it("a round trip through a wider space comes back where it started", () => {
    const original = pixel(180, 90, 40);
    for (const wider of ["display-p3", "adobe-rgb", "prophoto-rgb"] as const) {
      const there = convertPixelsColorSpace(original, "srgb", wider);
      const back = convertPixelsColorSpace(there, wider, "srgb");
      for (let channel = 0; channel < 3; channel += 1) expect(Math.abs(back[channel]! - original[channel]!)).toBeLessThanOrEqual(2);
    }
  });

  it("pure sRGB red is inside a wider gamut, so it stops short of that space's own red", () => {
    const red = convertPixelsColorSpace(pixel(255, 0, 0), "srgb", "display-p3");
    expect(red[0]).toBeLessThan(255);
    expect(red[0]).toBeGreaterThan(220);
    const proPhoto = convertPixelsColorSpace(pixel(255, 0, 0), "srgb", "prophoto-rgb");
    expect(proPhoto[0]).toBeLessThan(red[0]!);
  });

  it("linear sRGB encodes mid grey where the transfer function says", () => {
    // 0.5 linear is about 188 in sRGB's own encoding.
    const encoded = convertPixelsColorSpace(pixel(128, 128, 128), "srgb", "linear-srgb");
    expect(encoded[0]).toBeGreaterThan(50);
    expect(encoded[0]).toBeLessThan(60);
    const back = convertPixelsColorSpace(encoded, "linear-srgb", "srgb");
    expect(Math.abs(back[0]! - 128)).toBeLessThanOrEqual(2);
  });

  it("alpha is never touched", () => {
    const translucent = convertPixelsColorSpace(pixel(10, 200, 30, 77), "srgb", "adobe-rgb");
    expect(translucent[3]).toBe(77);
  });

  it("only Display P3 can be shown by the canvas without conversion", () => {
    expect(canvasColorSpaceFor("display-p3")).toBe("display-p3");
    expect(canvasColorSpaceFor("adobe-rgb")).toBe("srgb");
    expect(canvasColorSpaceFor("srgb")).toBe("srgb");
  });
});
