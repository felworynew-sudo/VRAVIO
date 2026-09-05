/**
 * Stage 7 of docs/vector-plan.md: a second, independent implementation of
 * the same heavy math, proven to give the same answer as the first.
 *
 * `VectorGeometryPort` is the contract both implementations speak: a closed
 * polygon in, a flat array of closed polygons out — nothing richer, so a
 * slow TS reference (`createReferenceGeometryPort` below) and a fast WASM
 * port (`crates/vector-geometry`, loaded lazily from `apps/web` — this
 * package has no bundler of its own to fetch a `.wasm` file with) can be
 * swapped for each other, or cross-checked against each other, without
 * either side knowing the other's internals.
 */
export type BooleanOpKind = "union" | "subtract" | "intersect" | "exclude";

/**
 * A closed polygon as a flat `[x0, y0, x1, y1, ...]` array — no repeated
 * first point, no holes.
 *
 * Holes are an honest, documented gap for this first pass, not a silent
 * one: a shape that ends up with a hole after a boolean op (subtracting a
 * smaller rectangle out of the middle of a bigger one) comes back with the
 * hole's boundary as its own separate output polygon instead of a hole in
 * the outer one — both the TS reference and the WASM port make exactly
 * this simplification, so cross-checking them against each other stays
 * meaningful. Real hole support needs the wire format to carry ring
 * nesting; that's future work, not this stage's.
 */
export type FlatPolygon = Float64Array;

export interface VectorGeometryPort {
  /** Which implementation this is — shows up in the parity test's failure
   * messages and in whatever calls `booleanOp` when it wants to know
   * whether it's on the fast path or the fallback. */
  readonly name: string;
  /**
   * `| Promise<...>` rather than a plain async signature: the TS reference
   * answers synchronously (it's already loaded, being plain JS), while the
   * WASM port (`apps/web/src/vector-geometry-wasm.ts`) has to lazily fetch
   * and instantiate a `.wasm` module first. Both are honest about which
   * they are; a caller just always `await`s the result either way.
   */
  booleanOp(kind: BooleanOpKind, subject: FlatPolygon, clip: FlatPolygon): FlatPolygon[] | Promise<FlatPolygon[]>;
}
