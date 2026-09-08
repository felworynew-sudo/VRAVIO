import { describe, expect, it } from "vitest";
import { generateMonoPeaks, generatePeaks, readPeak } from "./peaks";

describe("generatePeaks", () => {
  it("captures the min/max of each pixel-column window", () => {
    // Window 1 = [0, 0.5, -0.5, 1] -> min -0.5, max 1. Window 2 = [-1, 0, 0.25, -0.25] -> min -1, max 0.25.
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0, 0.25, -0.25]);
    const peaks = generatePeaks(samples, 4, 16);
    expect(peaks).toHaveLength(4); // 2 columns * 2 (min,max)
    const first = readPeak(peaks, 0, 16);
    expect(first.min).toBeCloseTo(-0.5, 1);
    expect(first.max).toBeCloseTo(1, 1);
    const second = readPeak(peaks, 1, 16);
    expect(second.min).toBeCloseTo(-1, 1);
    expect(second.max).toBeCloseTo(0.25, 1);
  });

  it("clamps to the declared bit depth's range", () => {
    const samples = new Float32Array([1, -1]);
    const peaks8 = generatePeaks(samples, 2, 8);
    expect(peaks8[0]!).toBeGreaterThanOrEqual(-128);
    expect(peaks8[1]!).toBeLessThanOrEqual(127);
  });

  it("handles a final partial window", () => {
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    const peaks = generatePeaks(samples, 2, 16);
    expect(peaks).toHaveLength(4); // ceil(3/2) = 2 columns
  });

  it("throws for a non-positive samplesPerPixel", () => {
    expect(() => generatePeaks(new Float32Array(10), 0)).toThrow(RangeError);
  });
});

describe("generateMonoPeaks", () => {
  it("returns the single channel unchanged when there is only one", () => {
    const channel = new Float32Array([0, 1, -1, 0]);
    expect(generateMonoPeaks([channel], 2)).toEqual(generatePeaks(channel, 2));
  });

  it("averages multiple channels before generating peaks", () => {
    const left = new Float32Array([1, 1]);
    const right = new Float32Array([-1, -1]);
    const peaks = generateMonoPeaks([left, right], 2, 16);
    // averaged to 0 for both samples -> min=max=0
    const { min, max } = readPeak(peaks, 0, 16);
    expect(min).toBeCloseTo(0, 2);
    expect(max).toBeCloseTo(0, 2);
  });
});
