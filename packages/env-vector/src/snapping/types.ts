import type { TextMeasurer } from "../shape-ops";
import type { VectorShape } from "../types";

/**
 * A snap target reduced to its simplest useful shape: a line perpendicular
 * to one axis, at one document-space coordinate. Every snap type this stage
 * implements — a bounding-box edge, a shape's center, a path anchor, a grid
 * line — is exactly this once collected; the engine (`engine.ts`) never has
 * to know *why* a line exists, only where it is and what to call it when it
 * highlights.
 */
export interface SnapLine {
  readonly axis: "x" | "y";
  readonly value: number;
  /** Which source produced it — shown nowhere yet, kept for the day a
   * highlight wants to say "aligned with rectangle-3's center" rather than
   * just drawing a line. */
  readonly kind: string;
  /** The shape this line belongs to, if any — grid lines have none. Lets a
   * source (or a future caller) exclude a line that turns out to belong to
   * the very shape being dragged, on top of the exclusion the engine already
   * does by shape id. */
  readonly ownerId?: string;
}

/**
 * What a `SnapSource` is given to work with. `shapes` already excludes
 * whatever is being dragged (`excludeIds`) — a source never sees its own
 * candidate shape and does not have to filter it out itself, the same
 * "handed the right slice, not the whole document plus a rule to remember"
 * shape `shapeAt`'s own visibility/lock filtering already takes for its
 * candidates.
 */
export interface SnapContext {
  readonly shapes: readonly VectorShape[];
  readonly excludeIds: ReadonlySet<string>;
  readonly gridSpacing: number | null;
  /** Bounds the grid source's line enumeration — a document is finite, a
   * grid conceptually is not, and this is the difference between "every
   * multiple of the spacing that could ever matter" and "every multiple of
   * the spacing, forever". */
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly measurer?: TextMeasurer;
}

/**
 * One kind of thing a drag can snap to — a rectangle's file for this
 * catalogue. `env-vector` is a plain package outside apps/web's Vite build,
 * so there is no `import.meta.glob` to auto-discover these the way tools and
 * commands are discovered in apps/web (docs/vector-plan.md notes this
 * explicitly rather than pretending an auto-glob exists where it cannot):
 * `registry.ts` lists each source by hand, one import per file, and adding a
 * new snap type is still "add a file, add one line to the registry" — not
 * "find the right switch statement and add a branch to it".
 */
export interface SnapSource {
  readonly id: string;
  collect(context: SnapContext): readonly SnapLine[];
}
