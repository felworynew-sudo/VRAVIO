import type { VectorDocumentState, VectorShape, VectorShapeKind, VectorStyle } from "./types";

export interface VectorDocumentOptions {
  artboards?: boolean;
}

export function createVectorDocument(width = 1280, height = 720, options: VectorDocumentOptions = {}): VectorDocumentState {
  return { kind: "vector", schemaVersion: 2, width, height, artboards: options.artboards ?? false, shapes: [], activeShapeId: null, selection: [] };
}

export const defaultVectorStyle = (): VectorStyle => ({ fill: "#5be0b3", stroke: null, strokeWidth: 2, opacity: 1 });

let counter = 0;
/** Short, readable ids ("rectangle-1") rather than UUIDs — vector documents stay small enough that collisions across a session are not a concern, and the name doubles as a default label. */
function nextId(kind: VectorShapeKind): string {
  counter += 1;
  return `${kind}-${counter}`;
}

/** Places an image shape referencing an asset already sitting in the kernel's asset store — the
 * counterpart to createShape for the one kind that can't be conjured from nothing, since it
 * needs bytes to point at. */
export function createImageShape(x: number, y: number, width: number, height: number, pixelAssetId: string, name: string): VectorShape {
  const id = nextId("image");
  return { id, kind: "image", visible: true, locked: false, style: defaultVectorStyle(), x, y, width, height, rotation: 0, pixelAssetId, name };
}

/** Creates a shape at a canonical size, for a click-to-place default (a drag then resizes it in place). */
export function createShape(kind: VectorShapeKind, x: number, y: number, style: VectorStyle = defaultVectorStyle()): VectorShape {
  const id = nextId(kind);
  const base = { id, visible: true, locked: false, style };
  if (kind === "rectangle") return { ...base, kind, x, y, width: 160, height: 100, rotation: 0, cornerRadius: 0, name: `Rectangle (Прямоугольник) ${id}` };
  if (kind === "ellipse") return { ...base, kind, x, y, width: 160, height: 100, rotation: 0, name: `Ellipse (Эллипс) ${id}` };
  if (kind === "line") return { ...base, kind, x1: x, y1: y, x2: x + 160, y2: y, name: `Line (Линия) ${id}` };
  if (kind === "text") return { ...base, kind, x, y, value: "Text (Текст)", fontSize: 32, fontFamily: "Arial", align: "left", name: `Text (Текст) ${id}` };
  return { ...base, kind: "path", points: [{ x, y }], closed: false, name: `Path (Контур) ${id}` };
}
