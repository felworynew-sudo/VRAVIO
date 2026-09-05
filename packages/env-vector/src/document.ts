import { srgb } from "@vravio/kernel";
import { IDENTITY_MATRIX } from "./matrix";
import type { LengthUnit } from "./units";
import type { Artboard, VectorDocumentState, VectorShape, VectorShapeKind, VectorStyle } from "./types";

export interface VectorDocumentOptions {
  resolution?: number;
  displayUnit?: LengthUnit;
}

export function createVectorDocument(width = 1280, height = 720, options: VectorDocumentOptions = {}): VectorDocumentState {
  return {
    kind: "vector", schemaVersion: 3, width, height,
    artboards: [], resolution: options.resolution ?? 72, displayUnit: options.displayUnit ?? "px",
    shapes: [], activeShapeId: null, selection: [],
  };
}

export const defaultVectorStyle = (): VectorStyle => ({ fill: srgb(0x5b, 0xe0, 0xb3), stroke: null, strokeWidth: 2, opacity: 1 });

let artboardCounter = 0;
export function createArtboard(x: number, y: number, width: number, height: number, name?: string): Artboard {
  artboardCounter += 1;
  return { id: `artboard-${artboardCounter}`, name: name ?? `Artboard (Монтажная область) ${artboardCounter}`, x, y, width, height };
}

let counter = 0;
/** Short, readable ids ("rectangle-1") rather than UUIDs — vector documents stay small enough that collisions across a session are not a concern, and the name doubles as a default label. */
function nextId(kind: VectorShapeKind): string {
  counter += 1;
  return `${kind}-${counter}`;
}

// A placeholder that `appendShapeAt` (tree.ts) always overwrites the moment a
// shape actually joins a document — see its callers, `addShape` in
// shape-ops.ts and `groupShapes` in group-ops.ts. A shape is never usable
// with this value still on it, but leaving it out entirely would mean every
// factory below has to know about sibling order at construction time, which
// only the document it is about to join can answer.
const UNASSIGNED_ORDER_KEY = "unassigned";

/** Places an image shape referencing an asset already sitting in the kernel's asset store — the
 * counterpart to createShape for the one kind that can't be conjured from nothing, since it
 * needs bytes to point at. */
export function createImageShape(x: number, y: number, width: number, height: number, pixelAssetId: string, name: string): VectorShape {
  const id = nextId("image");
  return { id, kind: "image", visible: true, locked: false, style: defaultVectorStyle(), x, y, width, height, pixelAssetId, name, parentId: null, orderKey: UNASSIGNED_ORDER_KEY, transform: IDENTITY_MATRIX };
}

/** Creates a shape at a canonical size, for a click-to-place default (a drag then resizes it in place). */
export function createShape(kind: VectorShapeKind, x: number, y: number, style: VectorStyle = defaultVectorStyle()): VectorShape {
  const id = nextId(kind);
  const base = { id, visible: true, locked: false, style, parentId: null as string | null, orderKey: UNASSIGNED_ORDER_KEY, transform: IDENTITY_MATRIX };
  if (kind === "rectangle") return { ...base, kind, x, y, width: 160, height: 100, cornerRadius: 0, name: `Rectangle (Прямоугольник) ${id}` };
  if (kind === "ellipse") return { ...base, kind, x, y, width: 160, height: 100, name: `Ellipse (Эллипс) ${id}` };
  if (kind === "line") return { ...base, kind, x1: x, y1: y, x2: x + 160, y2: y, name: `Line (Линия) ${id}` };
  if (kind === "text") return { ...base, kind, x, y, value: "Text (Текст)", fontSize: 32, fontFamily: "Arial", align: "left", name: `Text (Текст) ${id}` };
  if (kind === "group") return { ...base, kind, expanded: true, name: `Group (Группа) ${id}` };
  return { ...base, kind: "path", points: [{ x, y }], closed: false, name: `Path (Контур) ${id}` };
}
