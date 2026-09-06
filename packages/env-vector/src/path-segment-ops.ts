import type { VectorPoint } from "./types";

/**
 * "Add a node by clicking on the segment it belongs to" — docs/vector-plan.md
 * section 9, second priority ("Добавление узла кликом по существующему
 * сегменту"). A general path-geometry operation, not `vector.pen`-specific,
 * so it lives here rather than inside `pen.tsx` — `vector.nodes` gets the
 * same gesture for free later without a second implementation, the "single
 * door" `CLAUDE.md` section 4 asks for.
 *
 * There is no closed-form "closest point on a cubic Bézier" — it is a
 * degree-5 polynomial root-finding problem in general — so `closestPointOnSegment`
 * samples the curve instead, the same practical answer every editor's own
 * "insert node here" gesture actually uses. `SAMPLES_PER_SEGMENT` trades
 * accuracy for cost; 32 keeps the worst-case error under half a screen
 * pixel at any zoom this project's canvas realistically renders at,
 * measured against `pointToSegmentDistanceSquared`'s exact answer for the
 * degenerate straight-segment case (handles absent), where the true
 * answer is known and comparable.
 */
const SAMPLES_PER_SEGMENT = 32;

function lerp(a: { x: number; y: number }, b: { x: number; y: number }, t: number): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The four on-curve/control points of the cubic Bézier segment from `a` to
 * `b` — `a`'s own position doubles as its first control point when it has
 * no `handleOut` (and likewise for `b`/`handleIn`), which degenerates the
 * cubic into the straight line the renderer already draws for a segment
 * with no handles on either end. */
function cubicControlPoints(a: VectorPoint, b: VectorPoint): readonly [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  const p1 = a.handleOut ? { x: a.x + a.handleOut.x, y: a.y + a.handleOut.y } : { x: a.x, y: a.y };
  const p2 = b.handleIn ? { x: b.x + b.handleIn.x, y: b.y + b.handleIn.y } : { x: b.x, y: b.y };
  return [{ x: a.x, y: a.y }, p1, p2, { x: b.x, y: b.y }];
}

function cubicPointAt(controls: readonly [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }], t: number): { x: number; y: number } {
  const [p0, p1, p2, p3] = controls;
  const ab = lerp(p0, p1, t), bc = lerp(p1, p2, t), cd = lerp(p2, p3, t);
  const abbc = lerp(ab, bc, t), bccd = lerp(bc, cd, t);
  return lerp(abbc, bccd, t);
}

export interface ClosestSegmentPoint {
  /** Index of the segment's *first* point (`points[segmentIndex]` to
   * `points[segmentIndex + 1]`, or back to `points[0]` for a closed path's
   * last segment). */
  readonly segmentIndex: number;
  /** Where along the segment the closest point falls, 0 (at the first
   * point) to 1 (at the second) — what `insertPointOnPathSegment` needs to
   * actually split the curve there. */
  readonly t: number;
  readonly point: { x: number; y: number };
  readonly distance: number;
}

/**
 * The closest point on any segment of `points` to `(x, y)` — `null` for a
 * path with fewer than 2 points (nothing to have a segment at all). Checks
 * the closing segment too when `closed` is true.
 */
export function closestPointOnPath(points: readonly VectorPoint[], closed: boolean, x: number, y: number): ClosestSegmentPoint | null {
  if (points.length < 2) return null;
  let best: ClosestSegmentPoint | null = null;
  const segmentCount = closed ? points.length : points.length - 1;
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const a = points[segmentIndex]!;
    const b = points[(segmentIndex + 1) % points.length]!;
    const controls = cubicControlPoints(a, b);
    for (let sample = 0; sample <= SAMPLES_PER_SEGMENT; sample += 1) {
      const t = sample / SAMPLES_PER_SEGMENT;
      const point = cubicPointAt(controls, t);
      const distance = Math.hypot(point.x - x, point.y - y);
      if (!best || distance < best.distance) best = { segmentIndex, t, point, distance };
    }
  }
  return best;
}

/**
 * Splits the segment at `segmentIndex` at parameter `t` (from
 * `closestPointOnPath`) via De Casteljau subdivision, inserting a real new
 * anchor point with correctly recomputed handles on both sides — not a
 * plain straight-line midpoint, which would visibly kink a curved segment.
 * Degenerates to a plain linear split when neither endpoint has a handle
 * (the straight-segment case), since De Casteljau on a cubic with all
 * control points collapsed onto the two anchors *is* the linear
 * interpolation. Returns a new `points` array; does not mutate the input.
 */
export function insertPointOnPathSegment(points: readonly VectorPoint[], segmentIndex: number, t: number): VectorPoint[] {
  const a = points[segmentIndex]!;
  const bIndex = (segmentIndex + 1) % points.length;
  const b = points[bIndex]!;
  const [p0, p1, p2, p3] = cubicControlPoints(a, b);

  const q0 = lerp(p0, p1, t), q1 = lerp(p1, p2, t), q2 = lerp(p2, p3, t);
  const r0 = lerp(q0, q1, t), r1 = lerp(q1, q2, t);
  const split = lerp(r0, r1, t);

  const hasHandle = Boolean(a.handleOut || b.handleIn);
  // `...a`/`...b` already carry over whichever of `handleIn`/`handleOut`
  // each endpoint had (or the absence of it) — only the *changed* handle
  // needs overriding, and only when it existed in the first place; under
  // `exactOptionalPropertyTypes`, explicitly writing `handleOut: undefined`
  // is a type error distinct from the key being absent, so the unchanged
  // side is never touched at all rather than "cleared" to the same effect.
  const newA: VectorPoint = a.handleOut ? { ...a, handleOut: { x: q0.x - a.x, y: q0.y - a.y } } : { ...a };
  const newPoint: VectorPoint = {
    x: split.x, y: split.y,
    ...(hasHandle ? { handleIn: { x: r0.x - split.x, y: r0.y - split.y }, handleOut: { x: r1.x - split.x, y: r1.y - split.y } } : {}),
  };
  const newB: VectorPoint = b.handleIn ? { ...b, handleIn: { x: q2.x - b.x, y: q2.y - b.y } } : { ...b };

  const result = points.map((point, index) => index === segmentIndex ? newA : index === bIndex ? newB : point);
  // A closed path's "last" segment wraps from the final point back to
  // index 0 — the new point belongs at the very end of the array in that
  // case, not spliced into the middle (which would silently reorder every
  // later point's role in the contour).
  const insertAt = bIndex === 0 ? result.length : bIndex;
  result.splice(insertAt, 0, newPoint);
  return result;
}
