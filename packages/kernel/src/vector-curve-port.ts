/**
 * Stage 8 of docs/vector-plan.md: "operations that leave curves behind, not
 * a thousand points." Offset, stroke-to-fill, and simplify — all three
 * speak SVG path-data strings in and out, the same format
 * `@vravio/env-vector`'s `pathData()` already produces and every renderer
 * in this codebase already consumes, so no new wire encoding is needed the
 * way Stage 7's flat-polygon-array `VectorGeometryPort` needed one.
 *
 * Unlike `VectorGeometryPort`, this stage's plan names Kurbo as *the*
 * implementation, not *a* reference one to be cross-checked against a
 * second — so there is only one `VectorCurvePort`, built lazily in
 * `apps/web/src/vector-geometry-wasm.ts` (same crate, same lazy-load
 * machinery as the boolean ops), no `createReferenceCurvePort()` twin.
 */
export type StrokeJoin = "miter" | "round" | "bevel";
export type StrokeCap = "butt" | "round" | "square";

export interface StrokeToFillStyle {
  readonly width: number;
  readonly cap: StrokeCap;
  readonly join: StrokeJoin;
  readonly miterLimit: number;
  readonly dash: readonly number[];
  readonly dashOffset: number;
}

export interface VectorCurvePort {
  readonly name: string;
  /** Grows (positive) or shrinks (negative) a filled path by `amount`. */
  offsetPath(d: string, amount: number, join: StrokeJoin, tolerance: number): string | Promise<string>;
  /** Bakes a stroke's width/cap/join/dash into the filled outline it paints as. */
  strokeToFill(d: string, style: StrokeToFillStyle, tolerance: number): string | Promise<string>;
  /** Reduces node count while staying within `accuracy` of the original
   * shape. Also the reverse-approximation step for a boolean op's polygon
   * output (straight `L` segments are valid path data too) — see
   * `vector-geometry.curves.test.ts`. */
  simplifyPath(d: string, accuracy: number): string | Promise<string>;
}
