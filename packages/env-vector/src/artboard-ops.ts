import { invertMatrix, transformVector } from "./matrix";
import { type TextMeasurer, type VectorBounds, shapeWorldBounds, translateShape } from "./shape-ops";
import { siblingsOf, worldTransform } from "./tree";
import type { Artboard, VectorDocumentState, VectorShape } from "./types";

/**
 * Stage 15 of docs/vector-plan.md: "the real problem is that Canvas itself
 * doesn't exist" — `state.width`/`state.height` used to be both "the
 * document's own default export size" and "the hard edge nothing can
 * render past" (`VectorWorkspace.tsx`'s `<svg viewBox="0 0 width height">`
 * clips there), so a second artboard placed anywhere else was invisible
 * and unreachable rather than merely off past the *active* artboard, the
 * way Illustrator's own canvas behaves.
 *
 * This file does not introduce a fixed "canvas size" — research into how
 * Penpot (an open-source, browser-based, SVG-rendered editor — the same
 * shape this codebase already is) handles this landed on the same answer:
 * its own canvas is "practically infinite", sized by what the content and
 * viewport actually need rather than a constant. `computeCanvasBounds`
 * mirrors that in the cheapest way this document model supports: the
 * union of the legacy default area, every artboard, and every top-level
 * shape's own world bounds, padded by a real margin so panning past the
 * edge of the nearest content doesn't immediately hit a wall. It is real,
 * grows with the document, and is not "literally infinite" — the
 * dedicated tile-cached renderer that would make a *literally* unbounded
 * canvas cheap to pan around (Penpot's own answer for very large
 * documents) is out of scope for this pass; see this stage's own honest
 * gaps in docs/vector-plan.md.
 */
const CANVAS_MARGIN = 400;

export function computeCanvasBounds(state: VectorDocumentState, measurer?: TextMeasurer): VectorBounds {
  const boxes: VectorBounds[] = [{ x: 0, y: 0, width: state.width, height: state.height }, ...state.artboards];
  for (const shape of siblingsOf(state.shapes, null)) boxes.push(shapeWorldBounds(shape, state.shapes, measurer));

  const minX = Math.min(...boxes.map((box) => box.x)), minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width)), maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX - CANVAS_MARGIN, y: minY - CANVAS_MARGIN, width: maxX - minX + CANVAS_MARGIN * 2, height: maxY - minY + CANVAS_MARGIN * 2 };
}

let artboardCounter = 0;

/** Places a new artboard and makes it the active one — the Artboard
 * tool's own "drag out a new one" gesture, and the Artboards panel's own
 * "add" action, both funnel through this. */
export function createArtboardAt(state: VectorDocumentState, x: number, y: number, width: number, height: number, name?: string): Artboard {
  artboardCounter += 1;
  const artboard: Artboard = { id: `artboard-${artboardCounter}`, name: name ?? `Artboard (Монтажная область) ${state.artboards.length + 1}`, x, y, width, height, bleed: 0 };
  state.artboards.push(artboard);
  state.activeArtboardId = artboard.id;
  return artboard;
}

/**
 * Raises *this* module's own `artboardCounter` past whatever a
 * just-restored document already contains — `document.ts`'s
 * `reseedShapeIdCounters` doc comment claims to already cover artboards,
 * but it only ever raised `document.ts`'s own separate (and, in live use,
 * dead) `createArtboard`/`artboardCounter` pair, never this file's —
 * the one `createArtboardAt` above (the Artboard tool, the Artboards
 * panel's own "add"/duplicate) actually mints ids from. A fresh session
 * reloading a document with `artboard-3` already in it could mint a
 * colliding `artboard-1`/`artboard-2` for its own first new artboard — the
 * exact bug class `reseedShapeIdCounters` and `reseedPaletteIdCounter`
 * were each written to close, left open here under a different module.
 * Called from the same choke point they are (`apps/web/src/kernel.ts`,
 * right after `autosave.restore()`).
 */
export function reseedArtboardIdCounter(state: VectorDocumentState): void {
  let max = 0;
  for (const artboard of state.artboards) {
    const match = /-(\d+)$/.exec(artboard.id);
    if (!match) continue;
    const value = Number(match[1]);
    if (value > max) max = value;
  }
  artboardCounter = Math.max(artboardCounter, max);
}

export function duplicateArtboard(state: VectorDocumentState, id: string): Artboard | null {
  const source = state.artboards.find((artboard) => artboard.id === id);
  if (!source) return null;
  // Offset so the copy doesn't sit exactly on top of the original,
  // unreachable underneath it — same "obviously a copy, not a ghost"
  // convention `duplicateShape` already uses.
  const copy = createArtboardAt(state, source.x + 40, source.y + 40, source.width, source.height, `${source.name} copy (копия)`);
  copy.bleed = source.bleed;
  return copy;
}

export function setArtboardBleed(state: VectorDocumentState, id: string, bleed: number): void {
  const artboard = state.artboards.find((item) => item.id === id);
  if (artboard) artboard.bleed = Math.max(0, bleed);
}

/** Removes the artboard's own rectangle — never the artwork sitting under
 * it, which is the entire point of an artboard being metadata rather than
 * a container (types.ts's own doc comment on `Artboard`). */
export function deleteArtboard(state: VectorDocumentState, id: string): void {
  state.artboards = state.artboards.filter((artboard) => artboard.id !== id);
  if (state.activeArtboardId === id) state.activeArtboardId = null;
}

export function renameArtboard(state: VectorDocumentState, id: string, name: string): void {
  const artboard = state.artboards.find((item) => item.id === id);
  if (artboard) artboard.name = name;
}

/**
 * Stage 15 of docs/vector-plan.md: "Reorder" — moves an artboard one slot
 * within `state.artboards` itself, changing numbering/export sequence
 * without touching a single rectangle's `x`/`y`. Deliberately separate from
 * `rearrangeArtboardsGrid` below (Illustrator's own two commands: "Reorder
 * All Artboards" swaps list order, "Rearrange All Artboards" repositions
 * the rectangles into a grid) — conflating them would mean an artist who
 * only wants artboard #3 renumbered to #2 for export purposes gets their
 * canvas rectangles silently relocated as a side effect.
 */
export function reorderArtboard(state: VectorDocumentState, id: string, direction: -1 | 1): void {
  const index = state.artboards.findIndex((artboard) => artboard.id === id);
  if (index < 0) return;
  const target = index + direction;
  if (target < 0 || target >= state.artboards.length) return;
  const artboards = [...state.artboards];
  [artboards[index], artboards[target]] = [artboards[target]!, artboards[index]!];
  state.artboards = artboards;
}

export type ArtboardGridLayout = "row" | "column";

/**
 * "Rearrange All Artboards" (Illustrator) — repositions every artboard's
 * rectangle into a uniform grid, in the document's own current list order
 * (the same order `reorderArtboard` above controls), starting from the
 * top-left corner of the artboards' current combined bounding box. Cell
 * size is the largest artboard's own width/height so none overlap
 * regardless of how differently sized they are, the same tradeoff
 * Illustrator's own dialog makes rather than packing cells tightly.
 * `layout: "row"` fills `count` artboards per row before wrapping to the
 * next row; `"column"` fills `count` per column before wrapping to the
 * next column. Reuses `moveArtboard` (not a second, separate translation
 * of shape positions) so "move artwork with it" stays the one door that
 * decision already has.
 */
export function rearrangeArtboardsGrid(state: VectorDocumentState, count: number, spacing: number, layout: ArtboardGridLayout, moveArtwork: boolean): void {
  if (state.artboards.length === 0 || count < 1) return;
  const originX = Math.min(...state.artboards.map((artboard) => artboard.x));
  const originY = Math.min(...state.artboards.map((artboard) => artboard.y));
  const cellWidth = Math.max(...state.artboards.map((artboard) => artboard.width)) + spacing;
  const cellHeight = Math.max(...state.artboards.map((artboard) => artboard.height)) + spacing;
  for (const [index, artboard] of state.artboards.entries()) {
    const [row, col] = layout === "row" ? [Math.floor(index / count), index % count] : [index % count, Math.floor(index / count)];
    const targetX = originX + col * cellWidth;
    const targetY = originY + row * cellHeight;
    moveArtboard(state, artboard.id, targetX - artboard.x, targetY - artboard.y, moveArtwork);
  }
}

/**
 * Moves an artboard's own rectangle by `(dx, dy)` and, when
 * `moveArtwork` is true, every top-level shape that spatially intersected
 * it *before* the move — "Move Artwork with Artboard" (docs/vector-plan.md
 * stage 15). Without the flag, the artboard's rectangle moves alone and
 * every object stays exactly where it was, the ordinary case for a
 * metadata rectangle that owns nothing.
 *
 * Each shape's own document-space delta is converted into its local space
 * before calling `translateShape` (which only ever moves "in local
 * space") — for the overwhelming common case, a top-level shape with an
 * identity transform, local space already *is* document space and this is
 * a no-op conversion; for one that has been rotated as a unit, it is not,
 * the same reasoning `select.tsx`'s own drag handler already applies.
 */
export function moveArtboard(state: VectorDocumentState, id: string, dx: number, dy: number, moveArtwork: boolean, before?: readonly VectorShape[]): void {
  const artboard = state.artboards.find((item) => item.id === id);
  if (!artboard) return;
  const movers = moveArtwork ? (before ?? shapesIntersectingRect(state, artboard)) : [];
  artboard.x += dx;
  artboard.y += dy;
  for (const shape of movers) {
    const live = state.shapes.find((item) => item.id === shape.id);
    if (!live) continue;
    const inverse = invertMatrix(worldTransform(live, state.shapes));
    const local = inverse ? transformVector(inverse, { x: dx, y: dy }) : { x: dx, y: dy };
    translateShape(state, live.id, local.x, local.y);
  }
}

/** Every top-level shape whose world bounds intersect `rect` — what "Move
 * Artwork with Artboard" moves along with the artboard, computed fresh at
 * the *start* of a drag (a caller re-computing this mid-drag would instead
 * pick up shapes the artboard has since moved onto, which is not what the
 * option means). Only top-level shapes: a shape nested in a group moves
 * with its group regardless, the same as every other multi-select move in
 * this codebase. */
export function shapesIntersectingRect(state: VectorDocumentState, rect: VectorBounds, measurer?: TextMeasurer): VectorShape[] {
  const intersects = (box: VectorBounds) => box.x < rect.x + rect.width && box.x + box.width > rect.x && box.y < rect.y + rect.height && box.y + box.height > rect.y;
  return siblingsOf(state.shapes, null).filter((shape) => intersects(shapeWorldBounds(shape, state.shapes, measurer)));
}
