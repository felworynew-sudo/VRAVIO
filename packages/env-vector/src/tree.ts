import { IDENTITY_MATRIX, type Matrix, multiplyMatrix } from "./matrix";
import { makeVectorOrderKey } from "./types";
import type { VectorDocumentState, VectorShape } from "./types";

/**
 * `state.shapes` is an unordered bag, exactly like `RasterLayer[]` in
 * `packages/env-raster/src/layer-tree.ts` — the array's own order is not the
 * paint order. `parentId` + `orderKey` are the source of truth, so that
 * reordering one shape touches one string, not every sibling's array index.
 */
export const siblingsOf = (shapes: readonly VectorShape[], parentId: string | null): VectorShape[] =>
  shapes.filter((shape) => shape.parentId === parentId).sort((a, b) => a.orderKey.localeCompare(b.orderKey));

/** Rewrites a run of siblings into evenly spaced order keys — call after any
 * reorder so the next insertion has room to sort correctly. */
export function reorderSiblings(ordered: readonly VectorShape[]): void {
  ordered.forEach((shape, index) => { (shape as { orderKey: string }).orderKey = makeVectorOrderKey(index); });
}

export interface VectorShapeRow { shape: VectorShape; depth: number }

/** Bottom-to-top paint order, with a group's children immediately following
 * it — a group has no geometry of its own, it is a position in this order
 * that its children paint at, the same way `<g>` has no visual besides what
 * is inside it. */
export function flattenVectorShapes(shapes: readonly VectorShape[], parentId: string | null = null): VectorShape[] {
  return siblingsOf(shapes, parentId).flatMap((shape) => shape.kind === "group" ? [shape, ...flattenVectorShapes(shapes, shape.id)] : [shape]);
}

/** Layers-panel order (topmost first), excluding descendants of a collapsed group. */
export function vectorShapeRows(shapes: readonly VectorShape[]): VectorShapeRow[] {
  const visit = (parentId: string | null, depth: number): VectorShapeRow[] => siblingsOf(shapes, parentId).reverse().flatMap((shape) => [
    { shape, depth },
    ...(shape.kind === "group" && shape.expanded ? visit(shape.id, depth + 1) : []),
  ]);
  return visit(null, 0);
}

export function vectorShapeDescendantIds(shapes: readonly VectorShape[], parentId: string): string[] {
  return siblingsOf(shapes, parentId).flatMap((shape) => [shape.id, ...vectorShapeDescendantIds(shapes, shape.id)]);
}

export function isShapeEffectivelyVisible(shape: VectorShape, shapes: readonly VectorShape[]): boolean {
  let current: VectorShape | undefined = shape;
  const seen = new Set<string>();
  while (current) {
    if (!current.visible || seen.has(current.id)) return false;
    seen.add(current.id);
    current = current.parentId ? shapes.find((candidate) => candidate.id === current!.parentId) : undefined;
  }
  return true;
}

export function isShapeEffectivelyLocked(shape: VectorShape, shapes: readonly VectorShape[]): boolean {
  let current: VectorShape | undefined = shape;
  const seen = new Set<string>();
  while (current) {
    if (current.locked || seen.has(current.id)) return true;
    seen.add(current.id);
    current = current.parentId ? shapes.find((candidate) => candidate.id === current!.parentId) : undefined;
  }
  return false;
}

/**
 * This shape's transform composed with every ancestor's, in the order that
 * maps a point in the shape's own local space (its x/y/points, untouched by
 * any group it sits in) into document space: outermost ancestor first,
 * innermost — the shape itself — last. Cuts a cycle short defensively rather
 * than looping forever; a well-formed document never has one, but a hand-
 * edited or corrupted `parentId` chain should not hang the editor.
 */
export function worldTransform(shape: VectorShape, shapes: readonly VectorShape[]): Matrix {
  const chain: Matrix[] = [];
  let current: VectorShape | undefined = shape;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current.transform);
    current = current.parentId ? shapes.find((candidate) => candidate.id === current!.parentId) : undefined;
  }
  chain.reverse();
  return chain.reduce((composed, matrix) => multiplyMatrix(composed, matrix), IDENTITY_MATRIX);
}

/** Assigns `parentId`/`orderKey` and adds the shape to the document —
 * `addShape` in shape-ops.ts is the top-level convenience that calls this
 * with `parentId: null`; grouping calls it directly to place a shape inside
 * a specific group. */
export function appendShapeAt(state: VectorDocumentState, shape: VectorShape, parentId: string | null = null): VectorShape {
  const peers = siblingsOf(state.shapes, parentId);
  (shape as { parentId: string | null }).parentId = parentId;
  (shape as { orderKey: string }).orderKey = makeVectorOrderKey(peers.length ? Number.parseInt(peers[peers.length - 1]!.orderKey, 36) + 1 : 0);
  state.shapes.push(shape);
  return shape;
}
