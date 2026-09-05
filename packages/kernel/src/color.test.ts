import { describe, expect, it } from "vitest";
import { colorToCss, colorToHex, cssToColor, srgb } from "./color";

describe("Color", () => {
  it("round-trips a hex string through cssToColor and back through colorToHex", () => {
    const color = cssToColor("#5be0b3");
    expect(color).toEqual({ space: "srgb", components: [0x5b, 0xe0, 0xb3], alpha: 1 });
    expect(colorToHex(color)).toBe("#5be0b3");
  });

  it("expands a 3-digit hex shorthand", () => {
    expect(cssToColor("#0f0")).toEqual({ space: "srgb", components: [0, 255, 0], alpha: 1 });
  });

  it("parses rgba() including alpha", () => {
    expect(cssToColor("rgba(10, 20, 30, 0.5)")).toEqual({ space: "srgb", components: [10, 20, 30], alpha: 0.5 });
  });

  it("renders srgb straight to a CSS rgba() string", () => {
    expect(colorToCss(srgb(91, 224, 179, 0.75))).toBe("rgba(91, 224, 179, 0.75)");
  });

  it("renders gray by repeating the one channel", () => {
    expect(colorToCss({ space: "gray", components: [128], alpha: 1 })).toBe("rgba(128, 128, 128, 1)");
  });

  it("cmyk of pure black (0,0,0,1) renders as black, and pure white (0,0,0,0) as white — the naive formula's two anchor points", () => {
    expect(colorToCss({ space: "cmyk", components: [0, 0, 0, 1], alpha: 1 })).toBe("rgba(0, 0, 0, 1)");
    expect(colorToCss({ space: "cmyk", components: [0, 0, 0, 0], alpha: 1 })).toBe("rgba(255, 255, 255, 1)");
  });

  it("falls back to a visible mid-grey for lab/spot rather than guessing a wrong colour", () => {
    expect(colorToCss({ space: "lab", components: [50, 0, 0], alpha: 1 })).toBe("rgba(128, 128, 128, 1)");
    expect(colorToCss({ space: "spot", components: [], alpha: 1 })).toBe("rgba(128, 128, 128, 1)");
  });

  it("an unrecognised CSS string becomes opaque black instead of throwing", () => {
    expect(cssToColor("not-a-colour")).toEqual({ space: "srgb", components: [0, 0, 0], alpha: 1 });
  });

  it("colorToHex converts a non-srgb colour through the same naive path colorToCss uses, not a different one", () => {
    // If this used a different formula than colorToCss, the swatch shown in an
    // <input type="color"> while editing a CMYK fill would not match what the
    // shape actually renders — exactly the kind of two-implementations-drift
    // bug this file's own doc comment warns about.
    const cmykBlack = { space: "cmyk" as const, components: [0, 0, 0, 1], alpha: 1 };
    expect(colorToHex(cmykBlack)).toBe("#000000");
  });
});
