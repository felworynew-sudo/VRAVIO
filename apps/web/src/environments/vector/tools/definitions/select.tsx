import { invertMatrix, resolveSnapForBounds, shapeAtIndexed, shapeWorldBounds, transformVector, translateShape, worldTransform, type SnapLine, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
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
  /** The line(s) the current drag is snapped to, for the Overlay to
   * highlight — docs/vector-plan.md stage 5's "подсветка того, к чему
   * привязались", without which a snap looks like the editor nudging a
   * shape on its own for no visible reason. */
  readonly snapLines: readonly SnapLine[];
}

const empty: SelectState = { drag: null, snapLines: [] };

/** Shared by `vector.select` and `vector.nodes`' own fallback (see `nodes.ts`) — the
 * exact pre-port "pick a shape, start a move drag, or deselect" tail. */
export function beginSelectDrag(context: ToolContext<SelectState>, pointer: ToolPointer): void {
  const hit = shapeAtIndexed(context.spatialIndex, context.document.shapes, pointer.point.x, pointer.point.y);
  if (hit) {
    context.setState({ drag: { shapeId: hit.id, start: pointer.point, before: context.snapshot() }, snapLines: [] });
    context.mutate((draft: VectorDocumentState) => { draft.activeShapeId = hit.id; draft.selection = [hit.id]; });
  } else {
    context.setState(empty);
    context.mutate((draft: VectorDocumentState) => { draft.activeShapeId = null; draft.selection = []; });
  }
}

/** The chain of parent group ids above a shape — excluded from its own snap
 * candidates alongside the shape itself, since a group's bounds are the
 * union of its children's (`shapeWorldBounds`'s own handling) and would
 * otherwise shift together with the very shape being dragged, chasing its
 * own tail instead of offering a stable target. */
function ancestorIds(shape: VectorShape, shapes: readonly VectorShape[]): string[] {
  const ids: string[] = [];
  let parentId = shape.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    ids.push(parentId);
    parentId = shapes.find((candidate) => candidate.id === parentId)?.parentId ?? null;
  }
  return ids;
}

const select: VectorToolDefinition<SelectState> = {
  id: "vector.select",
  createState: () => empty,

  onPointerDown: beginSelectDrag,

  onPointerMove(context: ToolContext<SelectState>, pointer: ToolPointer) {
    const drag = context.state.drag;
    if (!drag) return;
    const dx = pointer.point.x - drag.start.x, dy = pointer.point.y - drag.start.y;

    let snapLines: readonly SnapLine[] = [];
    context.mutate((draft: VectorDocumentState) => {
      const shape = draft.shapes.find((item) => item.id === drag.shapeId);
      if (!shape) return;
      const world = worldTransform(shape, draft.shapes);
      const inverse = invertMatrix(world);

      // The naive move's effect in world space — for a top-level shape
      // (identity transform, the common case) this is just (dx, dy); for a
      // shape inside a scaled or rotated group it is not, which is exactly
      // why this is computed rather than assumed.
      const worldDelta = transformVector(world, { x: dx, y: dy });
      const currentWorldBounds = shapeWorldBounds(shape, draft.shapes);
      const projectedBounds = { x: currentWorldBounds.x + worldDelta.x, y: currentWorldBounds.y + worldDelta.y, width: currentWorldBounds.width, height: currentWorldBounds.height };

      const excludeIds = new Set([shape.id, ...ancestorIds(shape, draft.shapes)]);
      const snap = resolveSnapForBounds(projectedBounds, context.snapping.radius, context.snapping.sources, {
        shapes: draft.shapes, excludeIds, gridSpacing: context.snapping.gridSpacing,
        documentWidth: draft.width, documentHeight: draft.height,
      });
      snapLines = snap.lines;

      const totalWorldDelta = { x: worldDelta.x + snap.dx, y: worldDelta.y + snap.dy };
      // Snapping is meaningless for a shape whose transform cannot be
      // inverted (a zero-scale ancestor) — the naive move still applies,
      // it just never snaps, the same fallback shapeAt's own inverse check
      // already uses.
      const localDelta = inverse ? transformVector(inverse, totalWorldDelta) : { x: dx, y: dy };
      translateShape(draft, drag.shapeId, localDelta.x, localDelta.y);
    });
    context.setState({ drag: { ...drag, start: pointer.point }, snapLines });
  },

  onGestureEnd(context: ToolContext<SelectState>) {
    const drag = context.state.drag;
    context.setState(empty);
    if (drag) context.commitDrag(drag.before, "Move Shape (Переместить фигуру)");
  },

  onDeactivate(context: ToolContext<SelectState>) {
    context.setState(empty);
  },

  Overlay({ state, document }) {
    // Full-canvas lines at the matched value(s) — docs/vector-plan.md stage
    // 5's "подсветка того, к чему привязались": without this, a shape
    // snapping into place looks like the editor nudging it on its own for
    // no visible reason. Drawn only while a drag is live and something
    // actually matched (`state.snapLines` is empty otherwise), same as
    // vector.nodes' handles only appear while there is a node to show them
    // for.
    if (!state.drag || !state.snapLines.length) return null;
    return <>{state.snapLines.map((line, index) => line.axis === "x"
      ? <line key={index} className="vector-snap-guide" x1={line.value} y1={0} x2={line.value} y2={document.height} vectorEffect="non-scaling-stroke"/>
      : <line key={index} className="vector-snap-guide" x1={0} y1={line.value} x2={document.width} y2={line.value} vectorEffect="non-scaling-stroke"/>)}</>;
  },
};

export default select;
