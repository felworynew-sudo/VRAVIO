import {
  distanceToPolyline, ellipseOutline, flattenPathOutline, pathSegmentBounds, pointInPolygon, roundedRectOutline,
  type Point,
} from "./geometry";
import { applyMatrix, invertMatrix } from "./matrix";
import { flattenVectorShapes, isShapeEffectivelyLocked, isShapeEffectivelyVisible, reorderSiblings, siblingsOf, vectorShapeDescendantIds, worldTransform } from "./tree";
import { makeVectorOrderKey } from "./types";
import type { VectorDocumentState, VectorShape } from "./types";

export interface VectorBounds { x: number; y: number; width: number; height: number }

/**
 * A real text measurer, injected rather than imported — this package has no
 * DOM, and `document.createElement("canvas").getContext("2d")` (what an
 * accurate measurement needs) is not something a pure geometry package
 * should depend on to stay portable and testable under plain Node (every
 * test in this package runs with no jsdom, on purpose). The app layer, which
 * does have a canvas, reuses `apps/web/src/textRender.ts`'s own font-string
 * building and passes a real measurer in here — see `VectorWorkspace.tsx`'s
 * and `DockLayout.tsx`'s call sites. Without one, text falls back to the
 * same estimate this package always used.
 */
export interface TextMeasurer {
  measure(value: string, fontFamily: string, fontSize: number): { width: number; ascent: number; descent: number };
}

/** The estimate this package used before a real measurer existed —
 * `value.length * fontSize * .55` is not a font metric, it is a guess that
 * happens to be in the right ballpark for a proportional Latin font. Kept as
 * the fallback (rather than deleted) for exactly the contexts that have no
 * canvas to measure with: this package's own tests, and any future
 * server-side use. */
function estimateTextBounds(shape: Extract<VectorShape, { kind: "text" }>): VectorBounds {
  return { x: shape.x, y: shape.y - shape.fontSize, width: Math.max(40, shape.value.length * shape.fontSize * .55), height: shape.fontSize * 1.3 };
}

/**
 * Axis-aligned bounds in the shape's own local space — ignoring every
 * ancestor's transform (see `shapeWorldBounds` for that). Curve-accurate for
 * a path (docs/vector-plan.md bug §2.1: the old `Math.min(...xs, 0)` bbox of
 * anchor points alone both stretched to the origin *and* ignored a curve
 * bulging past its own points — `pathSegmentBounds` fixes both at once), and
 * expanded by half the stroke width when the shape is stroked, since a
 * stroke is visually part of the shape and a selection box that clipped it
 * would be lying about what is on screen.
 */
export function shapeBounds(shape: VectorShape, measurer?: TextMeasurer): VectorBounds {
  if (shape.kind === "group") return { x: 0, y: 0, width: 0, height: 0 }; // see shapeWorldBounds — a group's extent depends on its children, which this signature has no way to see
  const fill = shapeFillBounds(shape, measurer);
  return shape.kind === "image" ? fill : padForStroke(fill, shape);
}

function shapeFillBounds(shape: VectorShape, measurer?: TextMeasurer): VectorBounds {
  if (shape.kind === "group") return { x: 0, y: 0, width: 0, height: 0 }; // unreachable via shapeBounds, which guards this itself; guarded again here so this function's own type is sound on its own
  if (shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "image") return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  if (shape.kind === "line") return { x: Math.min(shape.x1, shape.x2), y: Math.min(shape.y1, shape.y2), width: Math.abs(shape.x2 - shape.x1), height: Math.abs(shape.y2 - shape.y1) };
  if (shape.kind === "text") {
    if (!measurer) return estimateTextBounds(shape);
    const metrics = measurer.measure(shape.value, shape.fontFamily, shape.fontSize);
    // measureText's x is the anchor the shape's own `align` already accounts
    // for at render time (textAnchor: start/middle/end) — shapeBounds reports
    // the same left edge convention `align: "left"` has always used, so a
    // centred or right-aligned text's box shifts left of `shape.x` exactly as
    // far as its own alignment shifts the glyphs left of that point.
    const left = shape.align === "center" ? shape.x - metrics.width / 2 : shape.align === "right" ? shape.x - metrics.width : shape.x;
    return { x: left, y: shape.y - metrics.ascent, width: metrics.width, height: metrics.ascent + metrics.descent };
  }
  const bounds = pathSegmentBounds(shape.points);
  return bounds ? { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY } : { x: 0, y: 0, width: 0, height: 0 };
}

function padForStroke(bounds: VectorBounds, shape: VectorShape): VectorBounds {
  if (shape.kind === "group" || shape.kind === "image" || !shape.style.stroke) return bounds;
  const pad = shape.style.strokeWidth / 2;
  return { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 };
}

/** The document-space axis-aligned box enclosing a shape's (local-space)
 * bounds after its own and every ancestor's transform — what a selection
 * outline actually needs to draw for a shape sitting inside a rotated group.
 * A group's own box is the union of its children's, recursively, since a
 * group has no bounds of its own to speak of. */
export function shapeWorldBounds(shape: VectorShape, shapes: readonly VectorShape[], measurer?: TextMeasurer): VectorBounds {
  if (shape.kind === "group") {
    const children = siblingsOf(shapes, shape.id);
    if (children.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const boxes = children.map((child) => shapeWorldBounds(child, shapes, measurer));
    const minX = Math.min(...boxes.map((box) => box.x)), minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width)), maxY = Math.max(...boxes.map((box) => box.y + box.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  const world = worldTransform(shape, shapes);
  const local = shapeBounds(shape, measurer);
  const corners = [
    applyMatrix(world, { x: local.x, y: local.y }), applyMatrix(world, { x: local.x + local.width, y: local.y }),
    applyMatrix(world, { x: local.x, y: local.y + local.height }), applyMatrix(world, { x: local.x + local.width, y: local.y + local.height }),
  ];
  const xs = corners.map((corner) => corner.x), ys = corners.map((corner) => corner.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** A click within this many local units of an unstroked or hairline-stroked
 * line still counts as a hit — a mathematical line has zero width, and
 * requiring a pixel-perfect click on it would make thin lines nearly
 * unselectable. Not zoom-aware: `shapeAt` tests in each shape's own local
 * space, and a fixed local-unit tolerance corresponds to a different number
 * of *screen* pixels depending on the current zoom and any scale in the
 * shape's ancestor chain — a real fix threads the caller's effective zoom
 * through, which is a wider change than this stage's bounds/hit-testing
 * fixes and is left as a known gap. */
const MIN_LINE_HIT_TOLERANCE = 4;

/**
 * Whether `(x, y)` — in the shape's own local space — actually falls on the
 * shape as rendered: inside its fill when it has one, or within half a
 * stroke width of its outline when it has one. Replaces the old plain
 * bounding-box test (docs/vector-plan.md bug §2.2), which hit-tested a
 * click in a letter's counter or far from a thin diagonal line the same as a
 * click on solid fill.
 */
export function hitTestShape(shape: VectorShape, x: number, y: number, measurer?: TextMeasurer): boolean {
  const point: Point = { x, y };
  if (shape.kind === "group") return false;
  if (shape.kind === "image") { const b = shapeBounds(shape); return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; }
  if (shape.kind === "text") { const b = shapeBounds(shape, measurer); return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; } // real glyph outlines are stage 11's job
  if (shape.kind === "line") {
    if (!shape.style.stroke) return false; // nothing to click on — a line has no fill
    const tolerance = Math.max(shape.style.strokeWidth / 2, MIN_LINE_HIT_TOLERANCE);
    return distanceToPolyline([{ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }], point, false) <= tolerance;
  }
  const outline = shape.kind === "rectangle" ? roundedRectOutline(shape.x, shape.y, shape.width, shape.height, shape.cornerRadius)
    : shape.kind === "ellipse" ? ellipseOutline(shape.x + shape.width / 2, shape.y + shape.height / 2, shape.width / 2, shape.height / 2)
    : flattenPathOutline(shape.points, true); // a fill hit-tests the same closed region a renderer fills, whether or not the path itself is closed
  if (shape.style.fill && pointInPolygon(outline, point)) return true;
  if (shape.style.stroke) {
    const strokeOutline = shape.kind === "path" ? flattenPathOutline(shape.points, shape.closed) : outline;
    // roundedRectOutline/ellipseOutline are bare vertex lists with no
    // embedded closing edge, so distanceToPolyline needs closed:true for
    // them; flattenPathOutline already walks the closing edge itself when
    // `closed` is true, so its own result is passed with closed:false here —
    // see flattenPathOutline's doc comment.
    const closed = shape.kind !== "path";
    if (distanceToPolyline(strokeOutline, point, closed) <= shape.style.strokeWidth / 2) return true;
  }
  return false;
}

/**
 * Topmost shape under a document-space point, mirroring how a click picks
 * the frontmost overlapping layer.
 *
 * A shape inside a group is tested in its *own local space*: the point is
 * mapped back through the inverse of the shape's world transform first, so a
 * click correctly finds a shape that a rotated or moved group has carried
 * somewhere else on the canvas, without `hitTestShape` needing to know
 * transforms exist. A group itself is never picked — same reasoning as
 * `shapeBounds`'s `{0,0,0,0}` for a group, there is nothing of a group's own
 * to click on, only what is in it, which is why it is skipped rather than
 * tested with an empty box.
 */
export function shapeAt(state: VectorDocumentState, x: number, y: number, measurer?: TextMeasurer): VectorShape | null {
  const painted = flattenVectorShapes(state.shapes);
  for (let index = painted.length - 1; index >= 0; index -= 1) {
    const shape = painted[index]!;
    if (shape.kind === "group") continue;
    if (!isShapeEffectivelyVisible(shape, state.shapes) || isShapeEffectivelyLocked(shape, state.shapes)) continue;
    const inverse = invertMatrix(worldTransform(shape, state.shapes));
    if (!inverse) continue;
    const local = applyMatrix(inverse, { x, y });
    if (hitTestShape(shape, local.x, local.y, measurer)) return shape;
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
