import type { VectorDocumentState, VectorShape } from "./types";

export interface VectorBounds { x: number; y: number; width: number; height: number }

/** Axis-aligned bounds in document space, ignoring rotation — enough for selection boxes and hit testing at the sizes these documents run at. */
export function shapeBounds(shape: VectorShape): VectorBounds {
  if (shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "image") return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  if (shape.kind === "line") return { x: Math.min(shape.x1, shape.x2), y: Math.min(shape.y1, shape.y2), width: Math.abs(shape.x2 - shape.x1), height: Math.abs(shape.y2 - shape.y1) };
  if (shape.kind === "text") return { x: shape.x, y: shape.y - shape.fontSize, width: Math.max(40, shape.value.length * shape.fontSize * .55), height: shape.fontSize * 1.3 };
  const xs = shape.points.map((point) => point.x), ys = shape.points.map((point) => point.y);
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 0), minY = Math.min(...ys, 0), maxY = Math.max(...ys, 0);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function hitTestShape(shape: VectorShape, x: number, y: number): boolean {
  const bounds = shapeBounds(shape);
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

/** Topmost shape under a point, mirroring how a click picks the frontmost overlapping layer. */
export function shapeAt(state: VectorDocumentState, x: number, y: number): VectorShape | null {
  for (let index = state.shapes.length - 1; index >= 0; index -= 1) {
    const shape = state.shapes[index]!;
    if (shape.visible && !shape.locked && hitTestShape(shape, x, y)) return shape;
  }
  return null;
}

export function addShape(state: VectorDocumentState, shape: VectorShape): void {
  state.shapes.push(shape);
  state.activeShapeId = shape.id;
  state.selection = [shape.id];
}

export function removeShapes(state: VectorDocumentState, ids: readonly string[]): void {
  const removed = new Set(ids);
  state.shapes = state.shapes.filter((shape) => !removed.has(shape.id));
  state.selection = state.selection.filter((id) => !removed.has(id));
  if (state.activeShapeId && removed.has(state.activeShapeId)) state.activeShapeId = state.selection[0] ?? null;
}

export function updateShape<T extends VectorShape>(state: VectorDocumentState, id: string, patch: Partial<T>): void {
  const index = state.shapes.findIndex((shape) => shape.id === id);
  if (index < 0) return;
  state.shapes[index] = { ...state.shapes[index]!, ...patch } as VectorShape;
}

/** Moves a shape by document-space delta — the common operation behind dragging on canvas. */
export function translateShape(state: VectorDocumentState, id: string, dx: number, dy: number): void {
  const shape = state.shapes.find((item) => item.id === id);
  if (!shape) return;
  if (shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "text" || shape.kind === "image") updateShape(state, id, { x: shape.x + dx, y: shape.y + dy });
  else if (shape.kind === "line") updateShape(state, id, { x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy });
  else if (shape.kind === "path") updateShape(state, id, { points: shape.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) });
}

export type ZOrderMove = "front" | "back" | "forward" | "backward";

export function moveShapeInStack(state: VectorDocumentState, id: string, move: ZOrderMove): void {
  const index = state.shapes.findIndex((shape) => shape.id === id);
  if (index < 0) return;
  const [shape] = state.shapes.splice(index, 1);
  if (move === "front") state.shapes.push(shape!);
  else if (move === "back") state.shapes.unshift(shape!);
  else if (move === "forward") state.shapes.splice(Math.min(state.shapes.length, index + 1), 0, shape!);
  else state.shapes.splice(Math.max(0, index - 1), 0, shape!);
}

let counter = 0;
export function duplicateShape(state: VectorDocumentState, id: string): VectorShape | null {
  const source = state.shapes.find((shape) => shape.id === id);
  if (!source) return null;
  counter += 1;
  const copy: VectorShape = structuredClone(source);
  (copy as { id: string }).id = `${source.kind}-copy-${counter}`;
  copy.name = `${source.name} copy (копия)`;
  const index = state.shapes.findIndex((shape) => shape.id === id);
  state.shapes.splice(index + 1, 0, copy);
  state.activeShapeId = copy.id;
  state.selection = [copy.id];
  return copy;
}
