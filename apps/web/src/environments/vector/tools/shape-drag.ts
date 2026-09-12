import { addShape, createShape, emptyVectorStyle, solidFill, solidStroke, updateShape, type VectorShapeKind } from "@vravio/env-vector";
import { cssToColor } from "@vravio/kernel";
import type { VectorSnapshot } from "../../../vector-commands";
import { boxFromDrag } from "../../../gesture-constraints";
import { constrainVectorTo45Degrees } from "./angle-constrain";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "./types";

/**
 * `vector.rectangle`, `vector.ellipse` and `vector.line` are the same
 * "drag from a start point" gesture — both fall into `shapeToolKinds` and
 * shared the entire `onPointerDown`/`onPointerMove`/`onPointerUp` body in
 * the pre-port `VectorWorkspace.tsx`, differing only in which
 * `VectorShapeKind` they create. One factory, one-screen definition files,
 * the same shape `marquee-selection.tsx`'s `createMarqueeTool(id, kind)`
 * already gave raster's marquee/ellipse-marquee/lasso family.
 *
 * `vector.line` needs two genuine branches, not just a third kind passed
 * through unchanged:
 *
 * - **Style.** A `line` shape renders as a native SVG `<line>`
 *   (`VectorWorkspace.tsx`'s `geometryFor`), which has no interior area at
 *   all — `fill` is simply never painted on it, per the SVG spec. Giving it
 *   the same `fills: [solidFill(...)]` style rectangle/ellipse get would
 *   draw a shape with a real, addressable style that is nonetheless
 *   permanently invisible — the exact "setting that does nothing" CLAUDE.md
 *   §3 rules out, just discovered at the drawing tool itself rather than an
 *   options-panel checkbox. A line gets a **stroke** instead.
 * - **Resize math.** Rectangle/ellipse resize by their own bounding box
 *   (`x`/`y`/`width`/`height`); a line has no such box — dragging moves its
 *   own second endpoint (`x2`/`y2`), the first staying at the click. `Shift`
 *   constrains that endpoint to the nearest 45°-multiple angle from the
 *   start, the same constraint `vector.pen`'s own segment-placement already
 *   uses (`../angle-constrain`, factored out once this became the second
 *   consumer) — Illustrator's own Line tool has the identical behaviour.
 */
export interface ShapeDragState {
  readonly drag: { readonly shapeId: string; readonly start: { readonly x: number; readonly y: number }; readonly before: VectorSnapshot } | null;
}

const empty: ShapeDragState = { drag: null };

export function createShapeDragTool(id: string, kind: VectorShapeKind): VectorToolDefinition<ShapeDragState> {
  return {
    id,
    createState: () => empty,

    onPointerDown(context: ToolContext<ShapeDragState>, pointer: ToolPointer) {
      const before = context.snapshot();
      const strokeWidth = typeof context.options.strokeWidth === "number" ? context.options.strokeWidth : 2;
      const style = kind === "line"
        ? { ...emptyVectorStyle(), strokes: [solidStroke(cssToColor(context.foregroundColor), strokeWidth)] }
        : { ...emptyVectorStyle(), fills: [solidFill(cssToColor(context.foregroundColor))] };
      const shape = createShape(kind, pointer.point.x, pointer.point.y, style);
      // "radius" only exists on vector.rectangle's option schema; a shape of
      // any other kind never reads it. Read here rather than left at
      // createShape's canonical default — otherwise the option is declared
      // and shown in the panel but never affects anything, the dead-checkbox
      // CLAUDE.md §3 rules out.
      if (shape.kind === "rectangle" && typeof context.options.radius === "number") shape.cornerRadius = context.options.radius;
      // A freshly-clicked line starts as createShape's own canonical
      // 160px-long horizontal default (`x2: x + 160, y2: y`) — visible and
      // real even before the first `onPointerMove`, matching every other
      // shape tool's own "a plain click, no drag, still leaves something."
      context.setState({ drag: { shapeId: shape.id, start: pointer.point, before } });
      context.mutate((draft) => addShape(draft, shape));
    },

    onPointerMove(context: ToolContext<ShapeDragState>, pointer: ToolPointer) {
      const drag = context.state.drag;
      if (!drag) return;
      const { start, shapeId } = drag;
      if (kind === "line") {
        let dx = pointer.point.x - start.x, dy = pointer.point.y - start.y;
        if (pointer.shiftKey) { const constrained = constrainVectorTo45Degrees(dx, dy); dx = constrained.x; dy = constrained.y; }
        context.mutate((draft) => updateShape(draft, shapeId, { x1: start.x, y1: start.y, x2: start.x + dx, y2: start.y + dy }));
        return;
      }
      const box = boxFromDrag(start, pointer.point, { shiftKey: pointer.shiftKey, altKey: pointer.altKey });
      context.mutate((draft) => updateShape(draft, shapeId, { x: box.x, y: box.y, width: Math.max(1, box.width), height: Math.max(1, box.height) }));
    },

    onGestureEnd(context: ToolContext<ShapeDragState>) {
      const drag = context.state.drag;
      context.setState(empty);
      if (drag) context.commitDrag(drag.before, "New Shape (Новая фигура)");
    },

    onDeactivate(context: ToolContext<ShapeDragState>) {
      context.setState(empty);
    },
  };
}
