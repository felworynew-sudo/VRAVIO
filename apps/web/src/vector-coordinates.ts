/**
 * Pure screen↔document coordinate math for the vector workspace — split out
 * of `VectorWorkspace.tsx` so it can be imported (and unit-tested, see
 * `vector-coordinates.test.ts`) without pulling in that component's own
 * DOM-dependent module-level code (`vector-text-metrics.ts`'s canvas-based
 * measurer, created at import time). Mirrors `raster-coordinates.ts`'s own
 * reason for existing as a separate file.
 */

interface Viewport {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
  readonly rotation: number;
}

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A pointer event's client coordinates, undoing the stage's own pan/zoom/
 * rotate CSS transform — into document space. `stageBounds` is the
 * document-space rectangle the scaled stage's own CSS box currently
 * represents (`computeCanvasBounds`, not necessarily the document's own
 * `width`/`height` — see stage 15's own write-up in `docs/vector-plan.md`):
 * the point the *stage itself* visually centres on (which is what the CSS
 * transform's own translate/scale/rotate actually centres) is
 * `stageBounds`'s centre, which is what this needs instead of assuming
 * document space starts at the stage's own origin.
 */
export function toDocumentPoint(event: { clientX: number; clientY: number }, workspace: HTMLElement, viewport: Viewport, stageBounds: Bounds): { x: number; y: number } {
  const rect = workspace.getBoundingClientRect();
  const dx = event.clientX - rect.left - rect.width / 2 - viewport.panX;
  const dy = event.clientY - rect.top - rect.height / 2 - viewport.panY;
  const radians = -viewport.rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  return { x: (cosine * dx - sine * dy) / viewport.zoom + stageBounds.x + stageBounds.width / 2, y: (sine * dx + cosine * dy) / viewport.zoom + stageBounds.y + stageBounds.height / 2 };
}

/**
 * The exact inverse of `toDocumentPoint` — a document-space point to screen
 * pixels *local to the workspace element's own top-left* (the same origin
 * `left`/`top`/an unscaled `<svg>`'s own coordinate space at `inset:0`
 * already uses), rather than `getBoundingClientRect()`-relative client
 * coordinates a pointer event carries.
 *
 * This is the piece `docs/master-plan.md` section 4.8's own svgedit
 * research (`select.js`'s `resize()`, `l * zoom, t * zoom, ...`) named as
 * missing before that refactor could start: a document→screen direction,
 * where the only one that existed was screen→document (`toDocumentPoint`,
 * for turning a pointer event into a hit-test coordinate). `workspaceSize`
 * rather than a DOM read, the same convention `VectorWorkspace.tsx`'s own
 * `visibleDocumentRect` already established for the same reason — the math
 * only needs the box's width/height, not a fresh layout read on every call.
 *
 * Round-trip correctness (document → screen → document lands back where it
 * started, across zoom/pan/rotation) is checked directly in
 * `vector-coordinates.test.ts` — hand-derived trigonometry like this is
 * cheap to get subtly wrong and cheap to actually prove.
 */
export function toScreenPoint(point: { x: number; y: number }, workspaceSize: { width: number; height: number }, viewport: Viewport, stageBounds: Bounds): { x: number; y: number } {
  const ux = (point.x - stageBounds.x - stageBounds.width / 2) * viewport.zoom;
  const uy = (point.y - stageBounds.y - stageBounds.height / 2) * viewport.zoom;
  const radians = viewport.rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  return { x: cosine * ux - sine * uy + workspaceSize.width / 2 + viewport.panX, y: sine * ux + cosine * uy + workspaceSize.height / 2 + viewport.panY };
}
