import { describe, expect, it } from "vitest";
import { exponentialCurve, fadeGainAt, generateCurve, linearCurve, logarithmicCurve, sCurveCurve } from "./fades";

describe("linearCurve", () => {
  it("fade-in ramps from 0 to 1", () => {
    const curve = linearCurve(11, true);
    expect(curve[0]).toBeCloseTo(0, 5);
    expect(curve[10]).toBeCloseTo(1, 5);
    expect(curve[5]).toBeCloseTo(0.5, 5);
  });

  it("fade-out ramps from 1 to 0", () => {
    const curve = linearCurve(11, false);
    expect(curve[0]).toBeCloseTo(1, 5);
    expect(curve[10]).toBeCloseTo(0, 5);
  });
});

describe("exponentialCurve / logarithmicCurve / sCurveCurve", () => {
  it("all start near 0 and end near 1 for fade-in", () => {
    for (const curve of [exponentialCurve(100, true), logarithmicCurve(100, true), sCurveCurve(100, true)]) {
      expect(curve[0]!).toBeLessThan(0.2);
      expect(curve[curve.length - 1]!).toBeGreaterThan(0.9);
    }
  });

  it("all start near 1 and end near 0 for fade-out", () => {
    for (const curve of [exponentialCurve(100, false), logarithmicCurve(100, false), sCurveCurve(100, false)]) {
      expect(curve[0]!).toBeGreaterThan(0.9);
      expect(curve[curve.length - 1]!).toBeLessThan(0.2);
    }
  });
});

describe("generateCurve", () => {
  it("dispatches to the right curve by type", () => {
    expect(generateCurve("linear", 11, true)[10]).toBeCloseTo(1, 5);
    expect(generateCurve("exponential", 10, true)).toHaveLength(10);
    expect(generateCurve("sCurve", 10, true)).toHaveLength(10);
    expect(generateCurve("logarithmic", 10, true)).toHaveLength(10);
  });

  it("returns an empty curve for non-positive length", () => {
    expect(generateCurve("linear", 0, true)).toHaveLength(0);
  });
});

describe("fadeGainAt", () => {
  it("is 1 outside any fade region", () => {
    expect(fadeGainAt(500, 1000, 100, 100, "linear")).toBe(1);
  });

  it("ramps up during the fade-in region", () => {
    expect(fadeGainAt(0, 1000, 100, 0, "linear")).toBeCloseTo(0, 1);
    expect(fadeGainAt(99, 1000, 100, 0, "linear")).toBeCloseTo(1, 1);
  });

  it("ramps down during the fade-out region", () => {
    // duration 1000, fadeOut 100 -> fade region is [900, 1000)
    expect(fadeGainAt(900, 1000, 0, 100, "linear")).toBeCloseTo(1, 1);
    expect(fadeGainAt(999, 1000, 0, 100, "linear")).toBeCloseTo(0, 1);
  });

  it("a clip with both fades applies fade-in first when they'd overlap at the very start", () => {
    // Degenerate/short clip: fadeIn dominates when index falls within it.
    expect(fadeGainAt(0, 50, 40, 40, "linear")).toBeCloseTo(0, 1);
  });
});
