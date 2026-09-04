import { shapeAt, translateShape, type VectorDocumentState } from "@vravio/env-vector";
import type { VectorSnapshot } from "../../../../vector-commands";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * Picks the topmost shape under the pointer and drags it — the pre-port
 * code's fall-through "Select tool" branch at the bottom of `onPointerDown`,
 * which `vector.nodes` also fell into whenever the click missed a node (see
 * `nodes.ts`). Clicking empty space deselects without a history step,
 * matching how a raster marquee click doesn't push an undo entry either —
 * "what is selected" has never itself been an undoable edit in this project.
 */
export interface SelectState {
  readonly drag: { readonly shapeId: string; readonly start: { readonly x: number; readonly y: number }; readonly before: VectorSnapshot } | null;
}

const empty: SelectState = { drag: null };

/** Shared by `vector.select` and `vector.nodes`' own fallback (see `nodes.ts`) — the
 * exact pre-port "pick a shape, start a move drag, or deselect" tail. */
export function beginSelectDrag(context: ToolContext<SelectState>, pointer: ToolPointer): void {
  const hit = shapeAt(context.document, pointer.point.x, pointer.point.y);
  if (hit) {
    context.setState({ drag: { shapeId: hit.id, start: pointer.point, before: context.snapshot() } });
    context.mutate((draft: VectorDocumentState) => { draft.activeShapeId = hit.id; draft.selection = [hit.id]; });
  } else {
    context.setState(empty);
    context.mutate((draft: VectorDocumentState) => { draft.activeShapeId = null; draft.selection = []; });
  }
}

const select: VectorToolDefinition<SelectState> = {
  id: "vector.select",
  createState: () => empty,

  onPointerDown: beginSelectDrag,

  onPointerMove(context: ToolContext<SelectState>, pointer: ToolPointer) {
    const drag = context.state.drag;
    if (!drag) return;
    const dx = pointer.point.x - drag.start.x, dy = pointer.point.y - drag.start.y;
    context.setState({ drag: { ...drag, start: pointer.point } });
    context.mutate((draft: VectorDocumentState) => translateShape(draft, drag.shapeId, dx, dy));
  },

  onGestureEnd(context: ToolContext<SelectState>) {
    const drag = context.state.drag;
    context.setState(empty);
    if (drag) context.commitDrag(drag.before, "Move Shape (Переместить фигуру)");
  },

  onDeactivate(context: ToolContext<SelectState>) {
    context.setState(empty);
  },
};

export default select;
