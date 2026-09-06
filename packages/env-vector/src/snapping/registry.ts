import bounds from "./sources/bounds";
import grid from "./sources/grid";
import guides from "./sources/guides";
import nodes from "./sources/nodes";
import segmentMidpoints from "./sources/segment-midpoints";
import type { SnapSource } from "./types";

/**
 * Every snap source, listed by hand — see `types.ts`'s own doc comment on
 * `SnapSource` for why this is an explicit list rather than an
 * `import.meta.glob` the way apps/web's tool and command catalogues are
 * discovered: `env-vector` has no Vite build of its own to do that
 * discovery with. Adding a new snap type is still "write the file, add one
 * line here" — not "find the right branch in a switch statement".
 *
 * Ruler guides were deferred at this stage's own first pass for want of a
 * ruler/guide model at all — stage 15 built one, and `guides` above closes
 * that gap. Curve intersections, tangents, perpendiculars and equal
 * spacing are still not here — real geometry-of-curve-intersection work,
 * a separate task from "there was no guide to snap to yet".
 */
export const snapSources: readonly SnapSource[] = [bounds, grid, guides, nodes, segmentMidpoints];
