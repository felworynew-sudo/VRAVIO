import type { VectorPoint } from "./types";

/**
 * The curve and hit-testing math `shapeBounds`/`hitTestShape` need, kept in
 * one file because every one of these functions is pure geometry with no
 * document or shape concept in it — exactly the kind of thing stage 7 of
 * docs/vector-plan.md expects to eventually hand to a WASM port. Nothing
 * here reads a `VectorShape`; `shape-ops.ts` is where geometry meets shapes.
 */
export interface Point { x: number; y: number }

/**
 * The exact axis-aligned bounds of one cubic Bézier segment — not the bounds
 * of its four control points, which is docs/vector-plan.md bug §2.1's other
 * half: a curve that bulges outside the hull of its own control points is
 * rare, but a curve that stays well *inside* that hull is the common case,
 * and a control-point bbox overstates it every time.
 *
 * The position function is a cubic in `t`; its derivative is a quadratic,
 * and the extrema are wherever that quadratic is zero, per axis. Evaluating
 * the cubic at those roots (clamped to (0,1), since a root outside the
 * segment does not occur on it) plus the two endpoints gives the true
 * extent.
 */
export function cubicBezierBounds(p0: Point, p1: Point, p2: Point, p3: Point): { minX: number; minY: number; maxX: number; maxY: number } {
  const axisExtrema = (v0: number, v1: number, v2: number, v3: number): [number, number] => {
    const at = (t: number) => (1 - t) ** 3 * v0 + 3 * (1 - t) ** 2 * t * v1 + 3 * (1 - t) * t ** 2 * v2 + t ** 3 * v3;
    const values = [v0, v3];
    // Derivative of the cubic Bézier, as a quadratic a·t² + b·t + c.
    const a = -3 * v0 + 9 * v1 - 9 * v2 + 3 * v3, b = 6 * v0 - 12 * v1 + 6 * v2, c = -3 * v0 + 3 * v1;
    if (Math.abs(a) < 1e-9) {
      // The quadratic degenerates to linear (b·t + c = 0): a single root, or
      // none if the derivative never changes (a straight run within the curve).
      if (Math.abs(b) > 1e-9) { const t = -c / b; if (t > 0 && t < 1) values.push(at(t)); }
    } else {
      const discriminant = b * b - 4 * a * c;
      if (discriminant >= 0) {
        const sqrtDiscriminant = Math.sqrt(discriminant);
        for (const t of [(-b + sqrtDiscriminant) / (2 * a), (-b - sqrtDiscriminant) / (2 * a)]) if (t > 0 && t < 1) values.push(at(t));
      }
    }
    return [Math.min(...values), Math.max(...values)];
  };
  const [minX, maxX] = axisExtrema(p0.x, p1.x, p2.x, p3.x);
  const [minY, maxY] = axisExtrema(p0.y, p1.y, p2.y, p3.y);
  return { minX, minY, maxX, maxY };
}

/** Points along one cubic Bézier segment, `t = 0` through `t = 1` inclusive —
 * the shared subdivision both fill hit-testing (as a polygon) and stroke
 * hit-testing (as a polyline) flatten a curved segment into. 16 steps is
 * plenty at the sizes these documents run at; stage 8's curve-accurate
 * offset/simplify work is where a tolerance-driven subdivision would start
 * to matter. */
export function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, steps = 16): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps, mt = 1 - t;
    points.push({
      x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
      y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y,
    });
  }
  return points;
}

/** Mirrors `path-data.ts`'s own rule for which segments are curved: a straight
 * line only when *neither* endpoint carries a handle. Any caller that needs
 * to walk a path's actual rendered shape (bounds, flattening, hit-testing)
 * goes through this, so "is this segment curved" is answered in exactly one
 * place — the alternative is `path-data.ts` and this file quietly drifting
 * on what counts as a corner. */
export function isStraightSegment(from: VectorPoint, to: VectorPoint): boolean {
  return !from.handleOut && !to.handleIn;
}

function bezierControlPoints(from: VectorPoint, to: VectorPoint): [Point, Point, Point, Point] {
  const c1 = from.handleOut ? { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y } : from;
  const c2 = to.handleIn ? { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y } : to;
  return [from, c1, c2, to];
}

/** The exact bounds of a whole path's points/handles, segment by segment —
 * what `shapeBounds` uses for a `path` shape in place of the old
 * `Math.min(...xs, 0)` bbox of the anchor points alone. An open path's
 * implicit closing edge (SVG fills an open `d` as if `Z` were appended) is
 * included, since a fill hit-test needs the same shape a renderer paints. */
export function pathSegmentBounds(points: readonly VectorPoint[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => {
    minX = Math.min(minX, bounds.minX); minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX); maxY = Math.max(maxY, bounds.maxY);
  };
  const segmentBounds = (from: VectorPoint, to: VectorPoint) => {
    if (isStraightSegment(from, to)) include({ minX: Math.min(from.x, to.x), minY: Math.min(from.y, to.y), maxX: Math.max(from.x, to.x), maxY: Math.max(from.y, to.y) });
    else include(cubicBezierBounds(...bezierControlPoints(from, to)));
  };
  include({ minX: points[0]!.x, minY: points[0]!.y, maxX: points[0]!.x, maxY: points[0]!.y });
  for (let i = 1; i < points.length; i += 1) segmentBounds(points[i - 1]!, points[i]!);
  // The implicit closing edge — see the doc comment above for why it counts
  // even when `closed` is false.
  if (points.length > 1) segmentBounds(points[points.length - 1]!, points[0]!);
  return { minX, minY, maxX, maxY };
}

/** A path's points and handles flattened into a polyline, honestly following
 * `closed`: the closing edge is only walked when the path is actually
 * closed, unlike `pathSegmentBounds`'s bounds (which treats every path as
 * implicitly closed to match how a fill renders). A stroke, unlike a fill,
 * only ever follows the segments a path actually has. */
export function flattenPathOutline(points: readonly VectorPoint[], closed: boolean): Point[] {
  if (!points.length) return [];
  const outline: Point[] = [{ x: points[0]!.x, y: points[0]!.y }];
  const walk = (from: VectorPoint, to: VectorPoint) => {
    if (isStraightSegment(from, to)) outline.push({ x: to.x, y: to.y });
    else outline.push(...flattenCubic(...bezierControlPoints(from, to)).slice(1));
  };
  for (let i = 1; i < points.length; i += 1) walk(points[i - 1]!, points[i]!);
  if (closed && points.length > 1) walk(points[points.length - 1]!, points[0]!);
  return outline;
}

/** Ray-casting, nonzero winding — the same fill rule SVG's default
 * `fill-rule: nonzero` uses, so a self-intersecting path hit-tests the same
 * region it visibly fills. */
export function pointInPolygon(polygon: readonly Point[], point: Point): boolean {
  let winding = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
    if (a.y <= point.y) {
      if (b.y > point.y && crossProduct(a, b, point) > 0) winding += 1;
    } else if (b.y <= point.y && crossProduct(a, b, point) < 0) winding -= 1;
  }
  return winding !== 0;
}

function crossProduct(a: Point, b: Point, point: Point): number {
  return (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y);
}

/** Squared distance to keep comparisons cheap — every caller only ever
 * compares against a threshold, never needs the actual distance. */
export function pointToSegmentDistanceSquared(a: Point, b: Point, point: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) { const ex = point.x - a.x, ey = point.y - a.y; return ex * ex + ey * ey; }
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  const px = a.x + t * dx, py = a.y + t * dy;
  const ex = point.x - px, ey = point.y - py;
  return ex * ex + ey * ey;
}

/** Minimum distance from a point to a polyline — the basis of stroke
 * hit-testing, since a stroke is "close to the path", not "inside a region". */
export function distanceToPolyline(polyline: readonly Point[], point: Point, closed: boolean): number {
  if (polyline.length === 0) return Infinity;
  if (polyline.length === 1) return Math.hypot(point.x - polyline[0]!.x, point.y - polyline[0]!.y);
  let best = Infinity;
  for (let i = 1; i < polyline.length; i += 1) best = Math.min(best, pointToSegmentDistanceSquared(polyline[i - 1]!, polyline[i]!, point));
  if (closed) best = Math.min(best, pointToSegmentDistanceSquared(polyline[polyline.length - 1]!, polyline[0]!, point));
  return Math.sqrt(best);
}

/** An ellipse's outline as an N-gon — accurate enough to hit-test with the
 * same `pointInPolygon` every other filled shape uses, rather than a second,
 * closed-form `((x-cx)/rx)² + ((y-cy)/ry)² <= 1` test that would have to be
 * kept in sync with this one by hand. 48 points keeps the polygon's own
 * error well under a pixel at the sizes these documents run at. */
export function ellipseOutline(cx: number, cy: number, rx: number, ry: number, steps = 48): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return points;
}

/**
 * A rectangle's outline, rounded corners included, as a polygon — the same
 * "one fill algorithm for every shape kind" reasoning as `ellipseOutline`:
 * without this, a click in a rounded-off corner (inside the axis-aligned
 * bbox, outside the visible rounded shape) would hit-test as a hit, which is
 * exactly the kind of "clicked the wrong thing" bug a hand-rolled per-corner
 * formula is easy to get subtly wrong and a shared polygon test is not.
 */
export function roundedRectOutline(x: number, y: number, width: number, height: number, radius: number, steps = 8): Point[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r < 1e-6) return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  const points: Point[] = [];
  const corner = (cx: number, cy: number, startAngle: number) => {
    for (let i = 0; i <= steps; i += 1) points.push({ x: cx + r * Math.cos(startAngle + (i / steps) * (Math.PI / 2)), y: cy + r * Math.sin(startAngle + (i / steps) * (Math.PI / 2)) });
  };
  corner(x + width - r, y + r, -Math.PI / 2); // top-right
  corner(x + width - r, y + height - r, 0); // bottom-right
  corner(x + r, y + height - r, Math.PI / 2); // bottom-left
  corner(x + r, y + r, Math.PI); // top-left
  return points;
}
