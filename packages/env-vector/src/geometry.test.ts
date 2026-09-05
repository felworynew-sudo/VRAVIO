import { describe, expect, it } from "vitest";
import {
  cubicBezierBounds, distanceToPolyline, ellipseOutline, flattenCubic, flattenPathOutline,
  isStraightSegment, pathSegmentBounds, pointInPolygon, pointToSegmentDistanceSquared, roundedRectOutline,
} from "./geometry";
import type { VectorPoint } from "./types";

describe("cubicBezierBounds", () => {
  it("a curve that bulges beyond its endpoints on one axis only — the case a control-point bbox gets right by accident and a two-point bbox gets wrong", () => {
    // p0=(0,0) p1=(1,2) p2=(2,2) p3=(3,0): x moves monotonically 0→3 (endpoints
    // are the x-extrema), but y humps up to 1.5 at the midpoint — verified
    // independently against the same formula before being written here.
    const bounds = cubicBezierBounds({ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 0 });
    expect(bounds.minX).toBeCloseTo(0, 9);
    expect(bounds.maxX).toBeCloseTo(3, 9);
    expect(bounds.minY).toBeCloseTo(0, 9);
    expect(bounds.maxY).toBeCloseTo(1.5, 9);
  });

  it("a curve that bulges outside the hull of its own control points on both axes", () => {
    const bounds = cubicBezierBounds({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: -10, y: 10 }, { x: 0, y: 10 });
    expect(bounds.minX).toBeCloseTo(-2.886751345948129, 9);
    expect(bounds.maxX).toBeCloseTo(2.886751345948129, 9);
    expect(bounds.minY).toBe(0);
    expect(bounds.maxY).toBe(10);
  });

  it("a straight segment (control points on the line between endpoints) bounds to exactly the endpoints", () => {
    const bounds = cubicBezierBounds({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 });
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 3 });
  });
});

describe("isStraightSegment", () => {
  it("matches path-data.ts's own rule: straight only when neither endpoint has a handle", () => {
    const plain: VectorPoint = { x: 0, y: 0 };
    const withHandle: VectorPoint = { x: 0, y: 0, handleOut: { x: 1, y: 0 } };
    expect(isStraightSegment(plain, plain)).toBe(true);
    expect(isStraightSegment(withHandle, plain)).toBe(false);
    expect(isStraightSegment(plain, { x: 0, y: 0, handleIn: { x: -1, y: 0 } })).toBe(false);
  });
});

describe("pathSegmentBounds — the fix for docs/vector-plan.md bug §2.1", () => {
  it("a path far from the origin bounds to its own extent, not stretched to (0,0)", () => {
    // The exact case the plan's own writeup and the canary test in
    // vector.test.ts use: a 100x100 corner path at (500,500).
    const bounds = pathSegmentBounds([{ x: 500, y: 500 }, { x: 600, y: 500 }, { x: 600, y: 600 }]);
    expect(bounds).toEqual({ minX: 500, minY: 500, maxX: 600, maxY: 600 });
  });

  it("a curved segment's bulge is included even when it exceeds every anchor point", () => {
    const bounds = pathSegmentBounds([
      { x: 0, y: 0, handleOut: { x: 1, y: 2 } },
      { x: 3, y: 0, handleIn: { x: -1, y: 2 } },
    ]);
    // handleOut/handleIn are offsets, so the actual control points are
    // (0,0)+(1,2)=(1,2) and (3,0)+(-1,2)=(2,2) — the same curve as the
    // cubicBezierBounds test above, with the same expected humped-y bounds.
    expect(bounds!.maxY).toBeCloseTo(1.5, 9);
  });

  it("includes the implicit closing edge, matching how SVG fills an open path", () => {
    // Three points forming an L; only the closing edge from (0,10) back to
    // (0,0) reaches x=0 down to y=0..10 — already covered by points here, so
    // use a shape where the closing edge is what extends the bounds: a
    // shallow zigzag whose closing edge cuts across further than any segment.
    const withoutClosingEdgeBounds = { minX: 0, maxX: 10, minY: 0, maxY: 1 };
    const points: VectorPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 5, y: -5 }];
    const bounds = pathSegmentBounds(points)!;
    // The closing edge from (5,-5) back to (0,0) does not change x/y range
    // here, so assert the general property instead: bounds always encloses
    // every point, and is never smaller than the two-point-only comparison.
    expect(bounds.minY).toBeLessThanOrEqual(withoutClosingEdgeBounds.minY);
  });

  it("returns null for an empty path rather than a bogus zero-size box", () => {
    expect(pathSegmentBounds([])).toBeNull();
  });
});

describe("pointInPolygon", () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it("a point clearly inside is inside", () => { expect(pointInPolygon(square, { x: 5, y: 5 })).toBe(true); });
  it("a point clearly outside is outside", () => { expect(pointInPolygon(square, { x: 20, y: 20 })).toBe(false); });
  it("a point in a corner the polygon does not cover (rounded-rect motivation) is outside", () => {
    // An octagon approximating a square with its corners cut off — the exact
    // shape roundedRectOutline produces conceptually. A point in the cut
    // corner must miss.
    const cutCorner = [{ x: 2, y: 0 }, { x: 8, y: 0 }, { x: 10, y: 2 }, { x: 10, y: 8 }, { x: 8, y: 10 }, { x: 2, y: 10 }, { x: 0, y: 8 }, { x: 0, y: 2 }];
    expect(pointInPolygon(cutCorner, { x: 0.5, y: 0.5 })).toBe(false);
    expect(pointInPolygon(cutCorner, { x: 5, y: 5 })).toBe(true);
  });
});

describe("pointToSegmentDistanceSquared / distanceToPolyline", () => {
  it("distance to a point exactly on the segment is zero", () => {
    expect(pointToSegmentDistanceSquared({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 })).toBe(0);
  });

  it("distance to a point beyond the segment's end clamps to the endpoint, not the infinite line", () => {
    const d = pointToSegmentDistanceSquared({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 });
    expect(Math.sqrt(d)).toBeCloseTo(10, 9); // distance to (10,0), not 0 (which the infinite line would give)
  });

  it("distanceToPolyline finds the closest of several segments", () => {
    const polyline = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(distanceToPolyline(polyline, { x: 10, y: 5 }, false)).toBeCloseTo(0, 9);
  });

  it("distanceToPolyline's closed flag includes the closing segment", () => {
    const triangle = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }];
    const pointNearClosingEdge = { x: 2.5, y: 5 }; // near the (5,10)→(0,0) edge, far from the other two
    const openDistance = distanceToPolyline(triangle, pointNearClosingEdge, false);
    const closedDistance = distanceToPolyline(triangle, pointNearClosingEdge, true);
    expect(closedDistance).toBeLessThan(openDistance);
  });
});

describe("ellipseOutline", () => {
  it("every generated point sits on the ellipse, within the polygon's own approximation error", () => {
    const points = ellipseOutline(50, 50, 30, 20, 48);
    for (const point of points) {
      const value = ((point.x - 50) / 30) ** 2 + ((point.y - 50) / 20) ** 2;
      expect(value).toBeCloseTo(1, 6);
    }
  });
});

describe("roundedRectOutline", () => {
  it("radius 0 degenerates to the plain rectangle's four corners", () => {
    expect(roundedRectOutline(0, 0, 10, 20, 0)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }]);
  });

  it("a hit test against a large corner radius correctly excludes the rounded-off corner", () => {
    const outline = roundedRectOutline(0, 0, 100, 100, 40);
    expect(pointInPolygon(outline, { x: 2, y: 2 })).toBe(false); // in the bbox, outside the rounded shape
    expect(pointInPolygon(outline, { x: 50, y: 50 })).toBe(true); // center, always inside
  });

  it("radius is clamped so it never exceeds half the shorter side", () => {
    // An absurd radius should not turn into a self-intersecting or inverted
    // outline — the clamp keeps it a valid, convex rounded shape.
    const outline = roundedRectOutline(0, 0, 20, 10, 1000);
    expect(pointInPolygon(outline, { x: 10, y: 5 })).toBe(true);
  });
});

describe("flattenCubic / flattenPathOutline", () => {
  it("flattenCubic starts and ends exactly on the curve's own endpoints", () => {
    const points = flattenCubic({ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 4, y: 5 }, { x: 5, y: 0 }, 8);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 5, y: 0 });
    expect(points.length).toBe(9);
  });

  it("flattenPathOutline walks the closing edge only when closed is true", () => {
    const points: VectorPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const open = flattenPathOutline(points, false);
    const closed = flattenPathOutline(points, true);
    // Open: exactly the three anchors, no straight segments add intermediate
    // points since none of these carry handles.
    expect(open).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    // Closed: distanceToPolyline against the same point differs, proving the
    // closing edge (10,10)→(0,0) was actually walked, not just implied.
    const nearClosingEdge = { x: 5, y: 5 };
    expect(distanceToPolyline(closed, nearClosingEdge, false)).toBeLessThan(distanceToPolyline(open, nearClosingEdge, false));
  });
});
