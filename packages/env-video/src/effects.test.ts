import { describe, expect, it } from "vitest";
import { videoClipFilterString, videoEffectCssFragment, videoEffectCatalog, videoEffectDefaults } from "./effects";

describe("videoEffectDefaults", () => {
  it("returns the catalog's own default values", () => {
    expect(videoEffectDefaults("brightness")).toEqual({ amount: 100 });
    expect(videoEffectDefaults("blur")).toEqual({ pixels: 0 });
  });

  it("returns an empty object for an unknown id", () => {
    expect(videoEffectDefaults("nonsense" as never)).toEqual({});
  });
});

describe("videoEffectCssFragment", () => {
  it("produces the correct CSS filter function per effect", () => {
    expect(videoEffectCssFragment("brightness", { amount: 150 })).toBe("brightness(1.5)");
    expect(videoEffectCssFragment("contrast", { amount: 50 })).toBe("contrast(0.5)");
    expect(videoEffectCssFragment("saturation", { amount: 200 })).toBe("saturate(2)");
    expect(videoEffectCssFragment("blur", { pixels: 5 })).toBe("blur(5px)");
    expect(videoEffectCssFragment("grayscale", { amount: 100 })).toBe("grayscale(1)");
    expect(videoEffectCssFragment("sepia", { amount: 100 })).toBe("sepia(1)");
    expect(videoEffectCssFragment("invert", { amount: 100 })).toBe("invert(1)");
    expect(videoEffectCssFragment("hueRotate", { degrees: 90 })).toBe("hue-rotate(90deg)");
  });

  it("falls back to the catalog default for a missing param", () => {
    expect(videoEffectCssFragment("brightness", {})).toBe("brightness(1)");
  });

  it("never lets blur go negative", () => {
    expect(videoEffectCssFragment("blur", { pixels: -10 })).toBe("blur(0px)");
  });
});

describe("videoClipFilterString", () => {
  it("returns \"none\" for an empty stack", () => {
    expect(videoClipFilterString([])).toBe("none");
  });

  it("skips disabled effects", () => {
    const result = videoClipFilterString([
      { effectId: "brightness", params: { amount: 50 }, enabled: false },
      { effectId: "contrast", params: { amount: 150 }, enabled: true },
    ]);
    expect(result).toBe("contrast(1.5)");
  });

  it("returns \"none\" when every effect is disabled", () => {
    const result = videoClipFilterString([{ effectId: "brightness", params: { amount: 50 }, enabled: false }]);
    expect(result).toBe("none");
  });

  it("joins multiple enabled effects in stack order", () => {
    const result = videoClipFilterString([
      { effectId: "brightness", params: { amount: 120 }, enabled: true },
      { effectId: "grayscale", params: { amount: 100 }, enabled: true },
    ]);
    expect(result).toBe("brightness(1.2) grayscale(1)");
  });
});

describe("videoEffectCatalog", () => {
  it("every entry's id is unique", () => {
    const ids = videoEffectCatalog.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every parameter's default value sits within its own min/max", () => {
    for (const effect of videoEffectCatalog) for (const param of effect.parameters) {
      expect(param.value).toBeGreaterThanOrEqual(param.min);
      expect(param.value).toBeLessThanOrEqual(param.max);
    }
  });
});
