import type { VectorBounds } from "@vravio/env-vector";

/**
 * The selection frame's geometry: where its handles sit, which one a press
 * caught, and what dragging that one does to the box.
 *
 * Split out of the tool for the same reason `selection-rules.ts` is: this is
 * arithmetic with exact answers, and arithmetic that only exists inside a
 * pointer handler cannot be checked without a pointer.
 *
 * The layout is the raster Move tool's (`environments/raster/tools/definitions/
 * move.tsx`) — eight handles on the -1/0/1 grid, the opposite one as the anchor,
 * Shift keeping the aspect. Vector gets the same frame because the owner asked
 * for it not to be behind raster, and because a transform frame that behaves
 * differently in the two halves of the same editor is a worse answer than
 * either behaviour on its own.
 */

/** One of the eight grid positions; (0, 0) is not a handle. */
export interface FrameHandle { readonly x: -1 | 0 | 1; readonly y: -1 | 0 | 1 }

export const FRAME_HANDLES: readonly FrameHandle[] = [
  { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
  { x: -1, y: 0 }, { x: 1, y: 0 },
  { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 },
];

/** Where a handle sits on a box, in the box's own space. */
export function handlePoint(bounds: VectorBounds, handle: FrameHandle): { x: number; y: number } {
  return {
    x: bounds.x + ((handle.x + 1) / 2) * bounds.width,
    y: bounds.y + ((handle.y + 1) / 2) * bounds.height,
  };
}

/** The point that stays put while `handle` is dragged: the opposite corner,
 * or the opposite edge for a side handle. */
export function anchorPoint(bounds: VectorBounds, handle: FrameHandle): { x: number; y: number } {
  return handlePoint(bounds, { x: -handle.x as -1 | 0 | 1, y: -handle.y as -1 | 0 | 1 });
}

/**
 * Which handle a press caught, tested in screen pixels so the grab area is the
 * same size however far the document is zoomed — the whole reason the frame is
 * drawn in the screen layer in the first place.
 */
export function handleAtScreenPoint(
  screenHandles: readonly { readonly handle: FrameHandle; readonly point: { x: number; y: number } }[],
  screenX: number,
  screenY: number,
  tolerance = 7,
): FrameHandle | null {
  let best: { handle: FrameHandle; distance: number } | null = null;
  for (const entry of screenHandles) {
    const distance = Math.hypot(entry.point.x - screenX, entry.point.y - screenY);
    if (distance > tolerance) continue;
    if (!best || distance < best.distance) best = { handle: entry.handle, distance };
  }
  return best?.handle ?? null;
}

/**
 * The scale factors a drag produces.
 *
 * A side handle scales one axis only — its other factor is exactly 1, not
 * "whatever the pointer happened to do sideways". Shift keeps the aspect by
 * taking the larger of the two factors, which is what makes a corner drag feel
 * like it is following the pointer rather than lagging behind one axis of it.
 *
 * Guarded against collapsing the box: a factor is never smaller than a hair, so
 * a frame dragged past its own anchor does not invert into a zero-size box that
 * no further drag could ever recover from. (Raster's own frame clamps to a
 * minimum for the same reason.)
 */
export function scaleForHandleDrag(
  bounds: VectorBounds,
  handle: FrameHandle,
  pointer: { x: number; y: number },
  keepAspect: boolean,
): { x: number; y: number } {
  const anchor = anchorPoint(bounds, handle);
  const minimum = 0.01;
  const spanX = handlePoint(bounds, handle).x - anchor.x;
  const spanY = handlePoint(bounds, handle).y - anchor.y;
  let scaleX = handle.x === 0 || Math.abs(spanX) < 1e-6 ? 1 : (pointer.x - anchor.x) / spanX;
  let scaleY = handle.y === 0 || Math.abs(spanY) < 1e-6 ? 1 : (pointer.y - anchor.y) / spanY;
  if (keepAspect && handle.x !== 0 && handle.y !== 0) {
    const uniform = Math.abs(scaleX) >= Math.abs(scaleY) ? scaleX : scaleY;
    scaleX = uniform;
    scaleY = uniform;
  }
  const clamp = (value: number) => (Math.abs(value) < minimum ? Math.sign(value || 1) * minimum : value);
  return { x: clamp(scaleX), y: clamp(scaleY) };
}

/** The union of several boxes — the one frame a multiple selection gets. */
export function unionBounds(all: readonly VectorBounds[]): VectorBounds | null {
  const usable = all.filter((bounds) => bounds.width >= 0 && bounds.height >= 0);
  if (!usable.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const bounds of usable) {
    left = Math.min(left, bounds.x); top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width); bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
