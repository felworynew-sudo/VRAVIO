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

/**
 * Toggles the anchor at `index` between a corner point (no handles, a
 * straight-line join on either side) and a smooth point (handles mirrored
 * through the anchor, tangent to the curve) — docs/vector-plan.md section 9,
 * third priority ("Умное преобразование угловой/сглаженной точки,
 * автосглаживание"). Illustrator's own Convert Anchor Point tool and
 * Inkscape's "make node smooth" do the same toggle; the auto-smooth
 * direction here is the standard heuristic both editors' behaviour
 * approximates for a freshly-smoothed point that never had handles to
 * begin with: tangent = direction from the previous anchor to the next
 * one, handle length = 1/3 the distance to each respective neighbour (a
 * common, not universal, Bézier "smooth through points" convention — not
 * a curvature-preserving fit, since the point had no curve to preserve
 * before this call).
 *
 * A point with only one neighbour (an open path's own endpoint) gets a
 * handle only on that one side — there is no "other side" tangent to
 * average with, and inventing one would curve the path *outward* past its
 * own end, which is not what smoothing an endpoint means in any editor.
 */
export function toggleCornerSmooth(points: readonly VectorPoint[], index: number, closed: boolean): VectorPoint[] {
  const point = points[index];
  if (!point) return points.slice();
  const isSmooth = Boolean(point.handleIn || point.handleOut);
  if (isSmooth) {
    const corner: VectorPoint = { x: point.x, y: point.y };
    return points.map((current, i) => i === index ? corner : current);
  }

  const prevIndex = index > 0 ? index - 1 : closed ? points.length - 1 : -1;
  const nextIndex = index < points.length - 1 ? index + 1 : closed ? 0 : -1;
  const prev = prevIndex >= 0 ? points[prevIndex] : undefined;
  const next = nextIndex >= 0 ? points[nextIndex] : undefined;
  if (!prev && !next) return points.slice();

  let tangent = { x: 0, y: 0 };
  if (prev && next) tangent = { x: next.x - prev.x, y: next.y - prev.y };
  else if (next) tangent = { x: next.x - point.x, y: next.y - point.y };
  else if (prev) tangent = { x: point.x - prev.x, y: point.y - prev.y };
  const tangentLength = Math.hypot(tangent.x, tangent.y);
  const unit = tangentLength > 0 ? { x: tangent.x / tangentLength, y: tangent.y / tangentLength } : { x: 1, y: 0 };

  const smoothed: VectorPoint = { ...point };
  if (next) {
    const distanceToNext = Math.hypot(next.x - point.x, next.y - point.y);
    smoothed.handleOut = { x: unit.x * distanceToNext / 3, y: unit.y * distanceToNext / 3 };
  }
  if (prev) {
    const distanceToPrev = Math.hypot(point.x - prev.x, point.y - prev.y);
    smoothed.handleIn = { x: -unit.x * distanceToPrev / 3, y: -unit.y * distanceToPrev / 3 };
  }
  return points.map((current, i) => i === index ? smoothed : current);
}

/**
 * Removes the anchor at `index`, recomputing the surviving neighbours'
 * handles so the new, single segment between them approximates the shape
 * the *two* removed segments used to trace — docs/vector-plan.md section 9,
 * third priority ("Удаление узла с сохранением кривизны контура, не просто
 * прямая между соседями"). This is a heuristic, not an exact fit (there is
 * no cubic that always exactly retraces two arbitrary cubics through a
 * removed point): each surviving neighbour keeps its *existing* tangent
 * direction (the handle it already had on the side away from the deleted
 * point) and its handle *length* is rescaled to the new, typically longer,
 * chord distance to the other surviving neighbour — the same "keep
 * direction, rescale length" idea `toggleCornerSmooth` uses for a fresh
 * point, applied here to a handle that already existed. A neighbour with
 * no handle on that side (a corner) is left a corner; deleting a point
 * between two corners still joins its neighbours with a straight line,
 * honestly, rather than inventing curvature that was never there.
 */
export function deletePointPreservingCurve(points: readonly VectorPoint[], index: number, closed: boolean): VectorPoint[] {
  const point = points[index];
  if (!point) return points.slice();
  const prevIndex = index > 0 ? index - 1 : closed ? points.length - 1 : -1;
  const nextIndex = index < points.length - 1 ? index + 1 : closed ? 0 : -1;
  const prev = prevIndex >= 0 ? points[prevIndex] : undefined;
  const next = nextIndex >= 0 ? points[nextIndex] : undefined;
  const newChordLength = prev && next ? Math.hypot(next.x - prev.x, next.y - prev.y) : 0;

  const rescale = (current: VectorPoint, part: "handleOut" | "handleIn"): VectorPoint => {
    const handle = current[part];
    if (!handle || newChordLength === 0) return current;
    // This neighbour's handle pointed *toward the deleted point* — its
    // length was calibrated to that (now-gone) distance. Keep the same
    // direction, rescale to a third of the new chord to the other
    // surviving neighbour, the same proportion `toggleCornerSmooth` uses.
    const length = Math.hypot(handle.x, handle.y);
    if (length === 0) return current;
    const unit = { x: handle.x / length, y: handle.y / length };
    const newLength = newChordLength / 3;
    return { ...current, [part]: { x: unit.x * newLength, y: unit.y * newLength } };
  };

  return points
    .filter((_, i) => i !== index)
    .map((current, i) => {
      // After filtering, `prev`'s own new index is unchanged (it was
      // before `index`); `next`'s shifts down by one — both identified by
      // object identity instead of recomputing indices, since a closed
      // path's wrap-around makes "one less than index" ambiguous at the
      // array boundary.
      if (current === prev) return rescale(current, "handleOut");
      if (current === next) return rescale(current, "handleIn");
      return current;
    });
}
