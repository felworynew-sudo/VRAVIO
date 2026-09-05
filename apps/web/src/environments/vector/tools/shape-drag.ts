import { addShape, createShape, updateShape, type VectorShapeKind } from "@vravio/env-vector";
import { cssToColor } from "@vravio/kernel";
import type { VectorSnapshot } from "../../../vector-commands";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "./types";

/**
 * `vector.rectangle` and `vector.ellipse` are the same gesture in the
 * pre-port code — both fall into `shapeToolKinds` and share the entire
 * `onPointerDown`/`onPointerMove`/`onPointerUp` body in `VectorWorkspace.tsx`,
 * differing only in which `VectorShapeKind` they create. One factory, two
 * one-screen definition files, the same shape `marquee-selection.tsx`'s
 * `createMarqueeTool(id, kind)` already gave raster's marquee/ellipse-marquee/
 * lasso family.
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
      const shape = createShape(kind, pointer.point.x, pointer.point.y, { fill: cssToColor(context.foregroundColor), stroke: null, strokeWidth: 2, opacity: 1 });
      // "radius" only exists on vector.rectangle's option schema; a shape of
      // any other kind never reads it. Read here rather than left at
      // createShape's canonical default — otherwise the option is declared
      // and shown in the panel but never affects anything, the dead-checkbox
      // CLAUDE.md §3 rules out.
      if (shape.kind === "rectangle" && typeof context.options.radius === "number") shape.cornerRadius = context.options.radius;
      context.setState({ drag: { shapeId: shape.id, start: pointer.point, before } });
      context.mutate((draft) => addShape(draft, shape));
    },

    onPointerMove(context: ToolContext<ShapeDragState>, pointer: ToolPointer) {
      const drag = context.state.drag;
      if (!drag) return;
      const { start, shapeId } = drag;
      const x = Math.min(start.x, pointer.point.x), y = Math.min(start.y, pointer.point.y);
      const width = Math.abs(pointer.point.x - start.x), height = Math.abs(pointer.point.y - start.y);
      context.mutate((draft) => updateShape(draft, shapeId, { x, y, width: Math.max(1, width), height: Math.max(1, height) }));
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
