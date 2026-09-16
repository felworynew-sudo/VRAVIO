import { describe, expect, it } from "vitest";
import { packEncoderInput, resizeLongestSide, scalePointToEncoderSpace, thresholdMask } from "./prepare";
import { interactiveSelectModelById, interactiveSelectModels } from "./registry";

describe("the model catalogue", () => {
  it("found the definition files", () => {
    expect(interactiveSelectModels.length).toBeGreaterThan(0);
  });

  it("finds MobileSAM by id", () => {
    const model = interactiveSelectModelById("mobile-sam");
    expect(model?.encoderInputSize).toBe(1024);
  });
});

describe("resizeLongestSide", () => {
  it("resizes so the longer side hits the target exactly, preserving aspect ratio", () => {
    const resized = resizeLongestSide(new Uint8ClampedArray(200 * 100 * 4), 200, 100, 1024);
    expect(resized.width).toBe(1024);
    expect(resized.height).toBe(512);
  });

  it("picks the tall side when the image is portrait", () => {
    const resized = resizeLongestSide(new Uint8ClampedArray(100 * 300 * 4), 100, 300, 1024);
    expect(resized.height).toBe(1024);
    expect(resized.width).toBeCloseTo(1024 / 3, 0);
  });

  it("leaves a square image square", () => {
    const resized = resizeLongestSide(new Uint8ClampedArray(50 * 50 * 4), 50, 50, 1024);
    expect(resized.width).toBe(1024);
    expect(resized.height).toBe(1024);
  });
});

describe("packEncoderInput", () => {
  it("packs RGB into HWC order, dropping alpha", () => {
    const pixels = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]); // two pixels
    const packed = packEncoderInput(pixels, 2, 1);
    expect(Array.from(packed)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("leaves raw 0..255 values untouched — the graph itself normalizes", () => {
    const pixels = new Uint8ClampedArray([255, 0, 128, 255]);
    const packed = packEncoderInput(pixels, 1, 1);
    expect(Array.from(packed)).toEqual([255, 0, 128]);
  });
});

describe("scalePointToEncoderSpace", () => {
  it("scales by the same factor resizeLongestSide would use", () => {
    // 200x100 original, encoder size 1024 -> scale = 1024/200 = 5.12
    const scaled = scalePointToEncoderSpace({ x: 100, y: 50, label: 1 }, 200, 100, 1024);
    expect(scaled.x).toBeCloseTo(512, 3);
    expect(scaled.y).toBeCloseTo(256, 3);
    expect(scaled.label).toBe(1);
  });

  it("uses the longer side's own scale even for a point measured on the shorter axis", () => {
    // 100x300 (portrait) -> scale = 1024/300
    const scaled = scalePointToEncoderSpace({ x: 50, y: 150, label: 0 }, 100, 300, 1024);
    const scale = 1024 / 300;
    expect(scaled.x).toBeCloseTo(50 * scale, 3);
    expect(scaled.y).toBeCloseTo(150 * scale, 3);
  });
});

describe("thresholdMask", () => {
  it("keeps positive logits, drops zero and negative ones", () => {
    const logits = new Float32Array([1.5, 0, -0.5, 0.001, -100]);
    const mask = thresholdMask(logits, 5, 1);
    expect(Array.from(mask)).toEqual([255, 0, 0, 255, 0]);
  });
});
