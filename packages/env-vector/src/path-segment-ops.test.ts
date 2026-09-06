import { describe, expect, it } from "vitest";
import { closestPointOnPath, insertPointOnPathSegment } from "./path-segment-ops";
import type { VectorPoint } from "./types";

describe("closestPointOnPath", () => {
  it("returns null for fewer than 2 points", () => {
    expect(closestPointOnPath([{ x: 0, y: 0 }], false, 5, 5)).toBeNull();
    expect(closestPointOnPath([], false, 0, 0)).toBeNull();
  });

  it("finds the closest point on a straight segment", () => {
    const points: VectorPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const result = closestPointOnPath(points, false, 40, 5);
    expect(result).not.toBeNull();
    expect(result!.segmentIndex).toBe(0);
    // Sampled at 32 steps along a 100-unit segment — up to ~1.6 units of
    // positional slop is expected and documented (`path-segment-ops.ts`'s
    // own "trades accuracy for cost" comment), not a precision bug to chase.
    expect(Math.abs(result!.t - 0.4)).toBeLessThan(0.05);
    expect(Math.abs(result!.point.x - 40)).toBeLessThan(2);
    expect(Math.abs(result!.point.y)).toBeLessThan(2);
    expect(Math.abs(result!.distance - 5)).toBeLessThan(2);
  });

  it("picks the correct segment out of several", () => {
    const points: VectorPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const result = closestPointOnPath(points, false, 100, 60);
    expect(result!.segmentIndex).toBe(1);
    expect(Math.abs(result!.point.y - 60)).toBeLessThan(2);
  });

  it("checks the closing segment of a closed path but not an open one", () => {
    const points: VectorPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const closedResult = closestPointOnPath(points, true, 50, 100);
    expect(closedResult!.segmentIndex).toBe(2); // the wrap-around segment, (100,100) -> (0,0)
    const openResult = closestPointOnPath(points, false, 50, 100);
    expect(openResult!.segmentIndex).not.toBe(2); // no such segment on an open path
  });

  it("finds a point on a curved (handled) segment that actually lies on the curve, not the chord", () => {
    // A segment bowed upward via handles — the straight-line chord's
    // midpoint (50, 0) is nowhere near the actual curve at t=0.5, which
    // bows up toward y≈-37 or so. Querying near the real curve midpoint
    // must resolve near t=0.5, not near the chord.
    const points: VectorPoint[] = [
      { x: 0, y: 0, handleOut: { x: 30, y: -50 } },
      { x: 100, y: 0, handleIn: { x: -30, y: -50 } },
    ];
    const result = closestPointOnPath(points, false, 50, -37.5)!;
    expect(result.t).toBeCloseTo(0.5, 1);
    expect(result.distance).toBeLessThan(3);
  });
});

describe("insertPointOnPathSegment", () => {
  it("splits a straight segment at the exact midpoint, with no handles on any of the three points", () => {
    const points: VectorPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const result = insertPointOnPathSegment(points, 0, 0.5);
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({ x: 50, y: 0, handleIn: undefined, handleOut: undefined });
    expect(result[0]!.handleOut).toBeUndefined();
    expect(result[2]!.handleIn).toBeUndefined();
  });

  it("splits a curved segment so the two resulting sub-curves together retrace the original curve", () => {
    const original: VectorPoint[] = [
      { x: 0, y: 0, handleOut: { x: 30, y: -60 } },
      { x: 100, y: 0, handleIn: { x: -30, y: -60 } },
    ];
    const split = insertPointOnPathSegment(original, 0, 0.5);
    expect(split).toHaveLength(3);

    // The new anchor must be the exact point the *original* curve passes
    // through at t=0.5 — proof this is a real De Casteljau split, not a
    // naive straight-line midpoint guess (which would land at (50,0), far
    // from the actual bowed curve).
    const originalAtHalf = closestPointOnPath(original, false, split[1]!.x, split[1]!.y)!;
    expect(originalAtHalf.distance).toBeLessThan(0.5);

    // And the two new sub-curves must retrace the original exactly: a
    // point sampled at the true quarter-mark of the original curve should
    // sit on the first half's own curve too, at its own midpoint.
    const [p0, p1, p2, p3] = [original[0]!, { x: original[0]!.x + original[0]!.handleOut!.x, y: original[0]!.y + original[0]!.handleOut!.y }, { x: original[1]!.x + original[1]!.handleIn!.x, y: original[1]!.y + original[1]!.handleIn!.y }, original[1]!];
    const lerp2 = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const ab = lerp2(p0, p1, 0.25), bc = lerp2(p1, p2, 0.25), cd = lerp2(p2, p3, 0.25);
    const quarterPoint = lerp2(lerp2(ab, bc, 0.25), lerp2(bc, cd, 0.25), 0.25);
    const onFirstHalf = closestPointOnPath([split[0]!, split[1]!], false, quarterPoint.x, quarterPoint.y)!;
    expect(onFirstHalf.distance).toBeLessThan(0.5);
    expect(onFirstHalf.t).toBeCloseTo(0.5, 1);
  });

  it("wraps the new point to the end of the array when splitting a closed path's last segment", () => {
    const points: VectorPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    // Segment index 2 is the closing one: (100,100) -> (0,0) (wraps to index 0).
    const result = insertPointOnPathSegment(points, 2, 0.5);
    expect(result).toHaveLength(4);
    expect(result[3]).toEqual({ x: 50, y: 50, handleIn: undefined, handleOut: undefined });
    // The original three points keep their own positions and relative order.
    expect(result.slice(0, 3)).toEqual(points);
  });

  it("does not mutate the input array", () => {
    const points: VectorPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const before = JSON.stringify(points);
    insertPointOnPathSegment(points, 0, 0.5);
    expect(JSON.stringify(points)).toBe(before);
  });
});
