import { describe, expect, it } from "vitest";
import { createWasmCurvePort, createWasmGeometryPort } from "./vector-geometry-wasm";

/**
 * Stage 8 of docs/vector-plan.md: "operations that leave curves behind, not
 * a thousand points" — offset, stroke-to-fill, and simplify, all through
 * the same lazily-loaded `crates/vector-geometry` WASM module Stage 7 set
 * up. Kurbo is named as *the* implementation here, not *a* reference one to
 * cross-check against a second (unlike Stage 7's boolean ops) — so these
 * tests assert concrete, known geometric facts about each function's
 * output, not agreement between two implementations.
 */

function bounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } {
  const numbers = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    minX = Math.min(minX, numbers[i]!); maxX = Math.max(maxX, numbers[i]!);
    minY = Math.min(minY, numbers[i + 1]!); maxY = Math.max(maxY, numbers[i + 1]!);
  }
  return { minX, minY, maxX, maxY };
}

function commandCount(d: string): number {
  return (d.match(/[MLCZ]/g) ?? []).length;
}

const curves = createWasmCurvePort();
const geometry = createWasmGeometryPort();

describe("VectorCurvePort — offsetPath", () => {
  it("grows a filled shape outward by a positive amount", async () => {
    const square = "M0,0 L100,0 L100,100 L0,100 Z";
    const grown = await curves.offsetPath(square, 10, "round", 0.1);
    const b = bounds(grown);
    expect(b.minX).toBeCloseTo(-10, 0);
    expect(b.minY).toBeCloseTo(-10, 0);
    expect(b.maxX).toBeCloseTo(110, 0);
    expect(b.maxY).toBeCloseTo(110, 0);
  });

  /**
   * A square, not a circle, for this one: Kurbo's own docs warn that a
   * negative expansion "is also likely to leave intersection artifacts at
   * corners," and a right-angle square hits exactly that — measured, its
   * shrink came back self-intersecting with the same bounding box as the
   * input, both for miter and round joins. A 32-gon circle approximation
   * shrinks cleanly instead, which is what this test actually exercises.
   */
  it("shrinks a filled shape inward by a negative amount", async () => {
    const circlePoints = Array.from({ length: 32 }, (_, i) => {
      const angle = (i / 32) * Math.PI * 2;
      return `${Math.cos(angle) * 100},${Math.sin(angle) * 100}`;
    });
    const circle = `M${circlePoints.join(" L")} Z`;
    const shrunk = await curves.offsetPath(circle, -20, "round", 0.1);
    const b = bounds(shrunk);
    expect(Math.max(Math.abs(b.minX), Math.abs(b.maxX))).toBeCloseTo(80, 0);
  });

  it("a round join actually adds curve commands at the corners, a miter join does not", async () => {
    const square = "M0,0 L100,0 L100,100 L0,100 Z";
    const rounded = await curves.offsetPath(square, 10, "round", 0.1);
    const mitered = await curves.offsetPath(square, 10, "miter", 0.1);
    expect(rounded).toContain("C");
    expect(mitered).not.toContain("C");
  });
});

describe("VectorCurvePort — strokeToFill", () => {
  it("bakes a stroke's width into a filled outline of the expected size", async () => {
    const line = "M0,0 L100,0";
    const filled = await curves.strokeToFill(line, { width: 10, cap: "butt", join: "miter", miterLimit: 4, dash: [], dashOffset: 0 }, 0.1);
    const b = bounds(filled);
    expect(b.minY).toBeCloseTo(-5, 0);
    expect(b.maxY).toBeCloseTo(5, 0);
    expect(b.minX).toBeCloseTo(0, 0);
    expect(b.maxX).toBeCloseTo(100, 0);
  });

  it("a round cap extends the filled shape past the line's own endpoints; a butt cap does not", async () => {
    const line = "M0,0 L100,0";
    const style = { width: 10, join: "miter" as const, miterLimit: 4, dash: [], dashOffset: 0 };
    const butt = await curves.strokeToFill(line, { ...style, cap: "butt" }, 0.1);
    const round = await curves.strokeToFill(line, { ...style, cap: "round" }, 0.1);
    expect(bounds(butt).maxX).toBeCloseTo(100, 0);
    expect(bounds(round).maxX).toBeGreaterThan(104);
  });
});

describe("VectorCurvePort — simplifyPath", () => {
  it("collapses a near-straight line with many redundant points down to a couple of segments", async () => {
    let noisy = "M0,0";
    for (let i = 1; i <= 50; i += 1) noisy += ` L${(i * 100) / 50},${0.001 * Math.sin(i)}`;
    expect(commandCount(noisy)).toBe(51);
    const simplified = await curves.simplifyPath(noisy, 0.1);
    expect(commandCount(simplified)).toBeLessThan(5);
  });

  it("is non-vacuous: tightening accuracy far below the input's own noise keeps far more detail", async () => {
    let noisy = "M0,0";
    for (let i = 1; i <= 50; i += 1) noisy += ` L${(i * 100) / 50},${0.001 * Math.sin(i)}`;
    const loose = await curves.simplifyPath(noisy, 0.01);
    const tight = await curves.simplifyPath(noisy, 0.000001);
    expect(commandCount(tight)).toBeGreaterThan(commandCount(loose));
  });

  /**
   * Stage 8's own measurement bullet ("union of two circles: single digits
   * of nodes, not hundreds") is recorded here honestly as **not achieved**
   * by this function, not silently dropped. `simplify_path`'s corner-
   * preserving default (see the doc comment on the Rust side) cannot tell
   * a flattened circle's ~5° per-vertex turns apart from a polygon someone
   * drew on purpose with that many sides, so it barely reduces one. This
   * test pins the actual measured number so a future attempt at real
   * curve-fitting (Kurbo's `fit_to_bezpath`) has a concrete "before" to
   * beat, and so this gap can't quietly regress into looking "handled."
   */
  it("measured: unioning two 64-sided circles does NOT come back down to single-digit nodes yet", async () => {
    const circle = (sides: number, r: number, cx: number, cy: number) => {
      const points: number[] = [];
      for (let i = 0; i < sides; i += 1) {
        const angle = (i / sides) * Math.PI * 2;
        points.push(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      }
      return new Float64Array(points);
    };
    const a = circle(64, 100, 0, 0), b = circle(64, 100, 80, 0);
    const [unioned] = await geometry.booleanOp("union", a, b);
    let path = "M";
    for (let i = 0; i < unioned!.length; i += 2) path += `${i === 0 ? "" : " L"}${unioned![i]},${unioned![i + 1]}`;
    path += " Z";
    const simplified = await curves.simplifyPath(path, 1);
    // Honest floor and ceiling on the measured gap, not a hopeful guess:
    // this documents "still tens of commands," not "single digits."
    expect(commandCount(simplified)).toBeGreaterThan(9);
    expect(commandCount(simplified)).toBeLessThan(200);
  });
});
