import bounds from "./sources/bounds";
import grid from "./sources/grid";
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
 * Ruler guides, curve intersections, tangents, perpendiculars and equal
 * spacing are in docs/vector-plan.md's list for this stage and are not
 * here — see that plan's own writeup for why each was deferred rather than
 * stubbed in.
 */
export const snapSources: readonly SnapSource[] = [bounds, grid, nodes, segmentMidpoints];
