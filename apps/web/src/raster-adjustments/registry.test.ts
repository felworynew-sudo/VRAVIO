import { describe, expect, it } from "vitest";
import { adjustedPixels } from "./apply";
import { rasterAdjustments } from "./registry";

describe("raster adjustment modules", () => {
  it("discovers every definition once and in menu order", () => {
    expect(rasterAdjustments.length).toBeGreaterThanOrEqual(9);
    expect(new Set(rasterAdjustments.map((item) => item.id)).size).toBe(rasterAdjustments.length);
    expect(rasterAdjustments.map((item) => item.order)).toEqual([...rasterAdjustments.map((item) => item.order)].sort((a, b) => a - b));
    expect(rasterAdjustments.find((item) => item.id === "levels")?.shortcut).toBe("Ctrl+L");
  });

  it("keeps preview calculations immutable and confines them to a selection", () => {
    const source = new Uint8ClampedArray([10, 20, 30, 255, 50, 60, 70, 255]);
    const selection = { mask: new Uint8ClampedArray([255, 0]), bounds: { x: 0, y: 0, width: 1, height: 1 } };
    const result = adjustedPixels(source, { kind: "invert" }, selection);
    expect([...source]).toEqual([10, 20, 30, 255, 50, 60, 70, 255]);
    expect([...result]).toEqual([245, 235, 225, 255, 50, 60, 70, 255]);
  });

  /**
   * Shift+Ctrl+U's grey is HSL lightness, (max + min) / 2, not luma — the two
   * disagree most on saturated colour, which is exactly where someone
   * "simplifying" this into the filter catalogue's `desaturate` (luma-weighted,
   * `.30/.59/.11`) would change the picture without breaking anything that
   * looks like a test. Pure red is 128 one way and 76 the other.
   */
  it("desaturates to HSL lightness, the way Photoshop's Shift+Ctrl+U does, not to luma", () => {
    const red = new Uint8ClampedArray([255, 0, 0, 255]);
    const [r, g, b] = adjustedPixels(red, { kind: "hueSaturation", hue: 0, saturation: -100, lightness: 0 }, null);
    expect([r, g, b]).toEqual([128, 128, 128]);
    expect(r).not.toBe(Math.round(255 * .3));

    // Grey stays exactly itself, and a second pass changes nothing.
    const grey = new Uint8ClampedArray([80, 80, 80, 255]);
    expect([...adjustedPixels(grey, { kind: "hueSaturation", hue: 0, saturation: -100, lightness: 0 }, null)]).toEqual([80, 80, 80, 255]);

    // Transparent pixels are left alone rather than painted grey.
    const clear = new Uint8ClampedArray([255, 0, 0, 0]);
    expect([...adjustedPixels(clear, { kind: "hueSaturation", hue: 0, saturation: -100, lightness: 0 }, null)]).toEqual([255, 0, 0, 0]);
  });
});
