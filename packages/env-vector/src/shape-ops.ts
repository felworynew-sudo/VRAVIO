import { applyMatrix, invertMatrix } from "./matrix";
import { flattenVectorShapes, isShapeEffectivelyLocked, isShapeEffectivelyVisible, reorderSiblings, siblingsOf, vectorShapeDescendantIds, worldTransform } from "./tree";
import { makeVectorOrderKey } from "./types";
import type { VectorDocumentState, VectorShape } from "./types";

export interface VectorBounds { x: number; y: number; width: number; height: number }

/**
 * Axis-aligned bounds in the shape's own local space — ignoring rotation and
 * ignoring every ancestor's transform. Stage 3 of docs/vector-plan.md owns
 * making this curve-accurate (bug §2.1: a path's bounds still stretch to the
 * origin via `Math.min(...xs, 0)`, left exactly as it was so that stage can
 * fix it and prove its own fix against a failing test); this stage's job is
 * only to make sure a shape *inside a group* gets these local bounds mapped
 * correctly into document space — see `shapeWorldBounds`.
 */
export function shapeBounds(shape: VectorShape): VectorBounds {
  if (shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "image") return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  if (shape.kind === "line") return { x: Math.min(shape.x1, shape.x2), y: Math.min(shape.y1, shape.y2), width: Math.abs(shape.x2 - shape.x1), height: Math.abs(shape.y2 - shape.y1) };
  if (shape.kind === "text") return { x: shape.x, y: shape.y - shape.fontSize, width: Math.max(40, shape.value.length * shape.fontSize * .55), height: shape.fontSize * 1.3 };
  if (shape.kind === "group") return { x: 0, y: 0, width: 0, height: 0 }; // see groupWorldBounds — a group's extent depends on its children, which this signature has no way to see
  const xs = shape.points.map((point) => point.x), ys = shape.points.map((point) => point.y);
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 0), minY = Math.min(...ys, 0), maxY = Math.max(...ys, 0);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The document-space axis-aligned box enclosing a shape's (local-space)
 * bounds after its own and every ancestor's transform — what a selection
 * outline actually needs to draw for a shape sitting inside a rotated group.
 * A group's own box is the union of its children's, recursively, since a
 * group has no bounds of its own to speak of. */
export function shapeWorldBounds(shape: VectorShape, shapes: readonly VectorShape[]): VectorBounds {
  if (shape.kind === "group") {
    const children = siblingsOf(shapes, shape.id);
    if (children.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const boxes = children.map((child) => shapeWorldBounds(child, shapes));
    const minX = Math.min(...boxes.map((box) => box.x)), minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width)), maxY = Math.max(...boxes.map((box) => box.y + box.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  const world = worldTransform(shape, shapes);
  const local = shapeBounds(shape);
  const corners = [
    applyMatrix(world, { x: local.x, y: local.y }), applyMatrix(world, { x: local.x + local.width, y: local.y }),
    applyMatrix(world, { x: local.x, y: local.y + local.height }), applyMatrix(world, { x: local.x + local.width, y: local.y + local.height }),
  ];
  const xs = corners.map((corner) => corner.x), ys = corners.map((corner) => corner.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export function hitTestShape(shape: VectorShape, x: number, y: number): boolean {
  const bounds = shapeBounds(shape);
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

/**
 * Topmost shape under a document-space point, mirroring how a click picks
 * the frontmost overlapping layer.
 *
 * A shape inside a group is tested in its *own local space*: the point is
 * mapped back through the inverse of the shape's world transform first, so a
 * click correctly finds a shape that a rotated or moved group has carried
 * somewhere else on the canvas, without `hitTestShape` itself (or stage 3's
 * eventual curve-accurate version of it) needing to know transforms exist. A
 * group itself is never picked — same reasoning as `shapeBounds`'s `{0,0,0,0}`
 * for a group, there is nothing of a group's own to click on, only what is in
 * it, which is why it is skipped rather than tested with an empty box.
 */
export function shapeAt(state: VectorDocumentState, x: number, y: number): VectorShape | null {
  const painted = flattenVectorShapes(state.shapes);
  for (let index = painted.length - 1; index >= 0; index -= 1) {
    const shape = painted[index]!;
    if (shape.kind === "group") continue;
    if (!isShapeEffectivelyVisible(shape, state.shapes) || isShapeEffectivelyLocked(shape, state.shapes)) continue;
    const inverse = invertMatrix(worldTransform(shape, state.shapes));
    if (!inverse) continue;
    const local = applyMatrix(inverse, { x, y });
    if (hitTestShape(shape, local.x, local.y)) return shape;
  }
  return null;
}

export function addShape(state: VectorDocumentState, shape: VectorShape): void {
  const peers = siblingsOf(state.shapes, null);
  (shape as { parentId: string | null }).parentId = null;
  (shape as { orderKey: string }).orderKey = makeVectorOrderKey(peers.length);
  state.shapes.push(shape);
  state.activeShapeId = shape.id;
  state.selection = [shape.id];
}

export function removeShapes(state: VectorDocumentState, ids: readonly string[]): void {
  const removed = new Set(ids.flatMap((id) => [id, ...vectorShapeDescendantIds(state.shapes, id)]));
  state.shapes = state.shapes.filter((shape) => !removed.has(shape.id));
  state.selection = state.selection.filter((id) => !removed.has(id));
  if (state.activeShapeId && removed.has(state.activeShapeId)) state.activeShapeId = state.selection[0] ?? null;
}

export function updateShape<T extends VectorShape>(state: VectorDocumentState, id: string, patch: Partial<T>): void {
  const index = state.shapes.findIndex((shape) => shape.id === id);
  if (index < 0) return;
  state.shapes[index] = { ...state.shapes[index]!, ...patch } as VectorShape;
}

/** Moves a shape by delta *in its own local space* — for a top-level shape
 * (the overwhelming majority, and every shape a v2 document ever had) that is
 * document space, since its transform is identity; for a shape inside a
 * transformed group a caller doing an on-canvas drag is expected to convert a
 * document-space delta into the shape's local space itself first (the inverse
 * of its parent's world transform), the same way `shapeAt` above converts a
 * point rather than this function taking on that unrelated responsibility. */
export function translateShape(state: VectorDocumentState, id: string, dx: number, dy: number): void {
  const shape = state.shapes.find((item) => item.id === id);
  if (!shape) return;
  if (shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "text" || shape.kind === "image") updateShape(state, id, { x: shape.x + dx, y: shape.y + dy });
  else if (shape.kind === "line") updateShape(state, id, { x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy });
  else if (shape.kind === "path") updateShape(state, id, { points: shape.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) });
}

export type ZOrderMove = "front" | "back" | "forward" | "backward";

/** Reorders a shape among its own siblings only — a shape inside a group
 * moves within that group, never escaping it, the same as
 * `packages/env-raster/src/layer-ops.ts`'s equivalent for layers. */
export function moveShapeInStack(state: VectorDocumentState, id: string, move: ZOrderMove): void {
  const shape = state.shapes.find((item) => item.id === id);
  if (!shape) return;
  const peers = siblingsOf(state.shapes, shape.parentId ?? null);
  const at = peers.findIndex((item) => item.id === id);
  if (at < 0) return;
  const target = move === "front" ? peers.length - 1 : move === "back" ? 0 : move === "forward" ? at + 1 : at - 1;
  if (target === at || target < 0 || target >= peers.length) return;
  const rest = peers.filter((item) => item.id !== id);
  reorderSiblings([...rest.slice(0, target), shape, ...rest.slice(target)]);
}

let counter = 0;
/** Duplicates a shape and, if it is a group, every descendant — mirroring
 * `packages/env-raster/src/layer-ops.ts`'s `duplicateLayer` so a duplicated
 * group's copy is a real independent group, not an empty one with the
 * originals still parented to the source. */
export function duplicateShape(state: VectorDocumentState, id: string): VectorShape | null {
  const source = state.shapes.find((shape) => shape.id === id);
  if (!source) return null;

  const copyOne = (shape: VectorShape, parentId: string | null): VectorShape => {
    counter += 1;
    const copy: VectorShape = { ...structuredClone(shape), id: `${shape.kind}-copy-${counter}`, parentId };
    state.shapes.push(copy);
    if (shape.kind === "group") for (const child of siblingsOf(state.shapes, shape.id)) copyOne(child, copy.id);
    return copy;
  };

  const copy = copyOne(source, source.parentId ?? null);
  copy.name = `${source.name} copy (копия)`;

  const peers = siblingsOf(state.shapes, source.parentId ?? null).filter((shape) => shape.id !== copy.id);
  const at = peers.findIndex((shape) => shape.id === source.id);
  reorderSiblings([...peers.slice(0, at + 1), copy, ...peers.slice(at + 1)]);
  state.activeShapeId = copy.id;
  state.selection = [copy.id];
  return copy;
}
