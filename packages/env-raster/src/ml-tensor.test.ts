import { describe, expect, it } from "vitest";
import { tensorToImage } from "./ml-tensor";

describe("tensorToImage", () => {
  it("reads an NCHW planar tensor back into interleaved RGBA, opaque when the tensor carries no alpha", () => {
    const width = 2, height = 1, pixelCount = width * height;
    // R plane, then G plane, then B plane — the layout every model in this
    // codebase actually exports (u2net, the inpainting models, the upscaler).
    const data = new Float32Array([
      1, 0, // R: pixel0=1, pixel1=0
      0, 1, // G: pixel0=0, pixel1=1
      0.5, 0.5, // B: both 0.5
    ]);
    const rgba = tensorToImage({ data, dims: [1, 3, height, width] }, width, height);
    expect(Array.from(rgba)).toEqual([255, 0, 128, 255, 0, 255, 128, 255]);
  });

  it("clamps values outside 0..1 instead of wrapping", () => {
    const data = new Float32Array([1.5, -0.5, 2, 0, 0, 0]);
    const rgba = tensorToImage({ data, dims: [1, 3, 1, 2] }, 2, 1);
    expect(rgba[0]).toBe(255); // 1.5 clamped to 1 -> 255
    expect(rgba[4]).toBe(0); // -0.5 clamped to 0 -> 0
  });

  it("throws when the tensor is smaller than the requested size", () => {
    const data = new Float32Array(3); // one pixel, not four
    expect(() => tensorToImage({ data, dims: [1, 3, 2, 2] }, 2, 2)).toThrow();
  });
});
