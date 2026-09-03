import { appendLayer, cloneRasterState, createRasterLayer, drawShape, parseHexColor, setLayerPixels, type Point, type ShapeKind } from "@vravio/env-raster";
import type { RasterToolDefinition } from "../types";

/**
 * Draws a rectangle, ellipse, line, polygon or star as a brand-new layer.
 *
 * The first tool in the catalogue that adds a layer rather than editing one
 * — `ctx.commit` only ever replaces an existing layer's pixels, so this is
 * what `ctx.commitDocument` exists for (see types.ts). Everything else here
 * is a plain drag-a-rect gesture, the same shape `marquee-selection.tsx`
 * already established.
 */

interface Draft {
  readonly pointerId: number;
  readonly from: Point;
  readonly current: Point;
}

interface ShapeState {
  readonly draw: Draft | null;
}

const empty: ShapeState = { draw: null };

const shapeLayerNames: Record<string, string> = {
  rectangle: "Rectangle (Прямоугольник)", roundedRectangle: "Rounded rectangle (Скруглённый прямоугольник)", ellipse: "Ellipse (Эллипс)",
  line: "Line (Линия)", triangle: "Triangle (Треугольник)", polygon: "Polygon (Многоугольник)", star: "Star (Звезда)",
};
const shapeLayerName = (kind: string): string => shapeLayerNames[kind] ?? "Shape (Фигура)";

const shape: RasterToolDefinition<ShapeState> = {
  id: "raster.shape",
  createState: () => empty,

  onPointerDown(context, pointer) {
    if (context.activeLayer?.locked) return;
    context.capturePointer(pointer.pointerId);
    context.setState({ draw: { pointerId: pointer.pointerId, from: pointer.point, current: pointer.point } });
  },

  onPointerMove(context, pointer) {
    const draw = context.state.draw;
    if (!draw || draw.pointerId !== pointer.pointerId) return;
    context.setState({ draw: { ...draw, current: pointer.point } });
  },

  onGestureEnd(context, pointer) {
    const draw = context.state.draw;
    context.setState(empty);
    if (!draw || draw.pointerId !== pointer.pointerId) return;

    const rect = { x: draw.from.x, y: draw.from.y, width: draw.current.x - draw.from.x, height: draw.current.y - draw.from.y };
    // A click that never became a drag draws nothing — there is no sane
    // shape to fit into a zero-area box.
    if (Math.abs(rect.width) < 1 && Math.abs(rect.height) < 1) return;

    const options = context.options;
    const mode = String(options.shapeMode ?? "fill");
    const kind = String(options.shapeKind ?? "rectangle") as ShapeKind;
    const before = cloneRasterState(context.document);
    const after = cloneRasterState(context.document);
    const layer = createRasterLayer(context.document.width, context.document.height, shapeLayerName(kind));
    drawShape(layer.pixels, context.document.width, context.document.height, {
      kind,
      rect,
      cornerRadius: Number(options.cornerRadius ?? 16),
      sides: Number(options.sides ?? 5),
      strokeWidth: Number(options.strokeWidth ?? 4),
      fill: mode === "stroke" ? null : parseHexColor(String(options.color ?? context.paintColor)),
      stroke: mode === "fill" ? null : parseHexColor(String(options.strokeColor ?? "#ffffff")),
    }, context.selection?.mask);
    setLayerPixels(layer, layer.pixels, context.document.width, context.document.height);
    appendLayer(after, layer);
    after.activeLayerId = layer.id;

    const strokePad = Number(options.strokeWidth ?? 4) + 2;
    const bounds = {
      x: Math.min(rect.x, rect.x + rect.width) - strokePad,
      y: Math.min(rect.y, rect.y + rect.height) - strokePad,
      width: Math.abs(rect.width) + strokePad * 2,
      height: Math.abs(rect.height) + strokePad * 2,
    };
    void context.commitDocument(before, after, "Shape (Фигура)", bounds);
  },

  onDeactivate(context) {
    if (context.state.draw) context.setState(empty);
  },

  Overlay({ state, document, options }) {
    const draw = state.draw;
    if (!draw) return null;
    const rect = { x: draw.from.x, y: draw.from.y, width: draw.current.x - draw.from.x, height: draw.current.y - draw.from.y };
    if (Math.abs(rect.width) <= 0 && Math.abs(rect.height) <= 0) return null;
    const box = { x: Math.min(rect.x, rect.x + rect.width), y: Math.min(rect.y, rect.y + rect.height), width: Math.abs(rect.width), height: Math.abs(rect.height) };
    const kind = String(options.shapeKind ?? "rectangle");
    // Matches the old preview exactly, simplification included: a triangle,
    // polygon or star drafts as its bounding box, not its real outline —
    // only the committed layer (`drawShape` above) draws those precisely.
    return <svg className="shape-draft" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
      {kind === "ellipse"
        ? <ellipse cx={box.x + box.width / 2} cy={box.y + box.height / 2} rx={box.width / 2} ry={box.height / 2}/>
        : kind === "line"
          ? <line x1={rect.x} y1={rect.y} x2={rect.x + rect.width} y2={rect.y + rect.height}/>
          : <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={kind === "roundedRectangle" ? Number(options.cornerRadius ?? 16) : 0}/>}
    </svg>;
  },
};

export default shape;
