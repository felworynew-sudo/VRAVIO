import { useEffect } from "react";
import { addShape, createShape, type VectorDocumentState } from "@vravio/env-vector";
import type { VectorSnapshot } from "../../../../vector-commands";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * Illustrator's pen: click to place a corner point, click-drag to pull a
 * symmetric Bézier handle out of the point just placed, double-click to
 * finish. Read off the pre-port `activeToolId === "vector.pen"` branch of
 * `onPointerDown`/`onPointerMove` plus the `pathDraft`/`penHandle` refs it
 * carried the gesture in.
 *
 * The pen's own right-click menu (Finish/Close/Delete Last Point/Delete
 * Path) and its Escape-cancels-the-whole-path shortcut have no pointer
 * gesture of their own to hang a hook off — the same shape raster.move's
 * Skew/Distort/Perspective/Warp menu is in, and the same answer applies:
 * `finishPath`/`closePath`/`deleteLastPoint`/`deletePath` are exported here
 * for the host's context menu to call, and Escape is handled inside this
 * tool's own `Overlay` (mirroring `vector.nodes`' Delete/Backspace and
 * `raster.move`'s Enter/Escape), not folded into the contract itself.
 */

export interface PenState {
  readonly draft: { readonly shapeId: string; readonly before: VectorSnapshot } | null;
  readonly handle: { readonly shapeId: string; readonly pointIndex: number; readonly anchor: { readonly x: number; readonly y: number } } | null;
}

const empty: PenState = { draft: null, handle: null };

/** Commits the in-progress path as-is — a right-click "Finish Path", but also
 * what `onDeactivate` falls back to: losing an in-progress path silently by
 * switching tools would be strictly worse than keeping whatever was placed
 * so far, the same choice the paint-stroke family's `onDeactivate` already
 * made ("сохранить работу лучше, чем потерять", docs/migration-plan.md). */
export function finishPath(context: ToolContext<PenState>): void {
  const draft = context.state.draft;
  if (!draft) return;
  context.setState(empty);
  context.commitDrag(draft.before, "New Path (Новый контур)");
}

/** Joins the last point back to the first, then finishes — a right-click "Close Path". */
export function closePath(context: ToolContext<PenState>): void {
  const draft = context.state.draft;
  if (!draft) return;
  context.mutate((document) => {
    const shape = document.shapes.find((item) => item.id === draft.shapeId);
    if (shape?.kind === "path") shape.closed = true;
  });
  finishPath(context);
}

/** Backs out one click without touching the rest — a right-click "Delete Last Point". */
export function deleteLastPoint(context: ToolContext<PenState>): void {
  const draft = context.state.draft;
  if (!draft) return;
  context.mutate((document) => {
    const shape = document.shapes.find((item) => item.id === draft.shapeId);
    if (shape?.kind === "path" && shape.points.length > 1) shape.points = shape.points.slice(0, -1);
  });
}

/** Discards the whole in-progress path, restoring exactly what was on the
 * canvas before it started — a right-click "Delete Path", and what Escape
 * does (see this tool's `Overlay`). No history step: nothing about this path
 * was ever committed for there to be an undo entry to record. */
export function deletePath(context: ToolContext<PenState>): void {
  const draft = context.state.draft;
  if (!draft) return;
  context.setState(empty);
  context.mutate((document) => {
    document.shapes = structuredClone(draft.before.shapes);
    document.activeShapeId = draft.before.activeShapeId;
    document.selection = draft.before.selection;
  });
}

export function hasDraft(context: ToolContext<PenState>): boolean {
  return context.state.draft !== null;
}

const pen: VectorToolDefinition<PenState> = {
  id: "vector.pen",
  createState: () => empty,

  onPointerDown(context, pointer: ToolPointer) {
    const draft = context.state.draft;
    if (draft) {
      const { shapeId } = draft;
      let pointIndex = -1;
      context.mutate((document: VectorDocumentState) => {
        const shape = document.shapes.find((item) => item.id === shapeId);
        if (shape?.kind === "path") { shape.points = [...shape.points, { x: pointer.point.x, y: pointer.point.y }]; pointIndex = shape.points.length - 1; }
      });
      if (pointIndex >= 0) context.setState({ draft, handle: { shapeId, pointIndex, anchor: pointer.point } });
      // A double-click finishes the path — the same `event.detail >= 2` test
      // the pre-port code read straight off the native PointerEvent.
      if (pointer.detail >= 2) finishPath(context);
      return;
    }
    const before = context.snapshot();
    // "strokeWidth" is vector.pen's own option; the pre-port code hardcoded
    // 2 regardless of what the panel showed — the dead-checkbox CLAUDE.md §3
    // rules out. A freshly drawn path still has no stroke *colour* (matches
    // Illustrator: a bare pen stroke is unstyled until Properties sets one,
    // and this project's own Properties panel — DockLayout.tsx — is exactly
    // where that stroke gets turned on), so the fix is narrow: the width the
    // option already promised now actually lands on the shape, ready for
    // the moment a stroke colour is turned on, rather than always "2".
    const strokeWidth = typeof context.options.strokeWidth === "number" ? context.options.strokeWidth : 2;
    const shape = createShape("path", pointer.point.x, pointer.point.y, { fill: context.foregroundColor, stroke: null, strokeWidth, opacity: 1 });
    context.setState({ draft: { shapeId: shape.id, before }, handle: { shapeId: shape.id, pointIndex: 0, anchor: pointer.point } });
    context.mutate((document: VectorDocumentState) => addShape(document, shape));
  },

  onPointerMove(context, pointer) {
    const handle = context.state.handle;
    if (!handle) return;
    const { shapeId, pointIndex, anchor } = handle;
    const dx = pointer.point.x - anchor.x, dy = pointer.point.y - anchor.y;
    // Below this, a click reads as a corner point, not an accidental one-pixel drag.
    if (Math.hypot(dx, dy) < 1) return;
    context.mutate((document: VectorDocumentState) => {
      const shape = document.shapes.find((item) => item.id === shapeId);
      if (shape?.kind === "path" && shape.points[pointIndex]) shape.points = shape.points.map((current, index) => index === pointIndex ? { ...current, handleOut: { x: dx, y: dy }, handleIn: { x: -dx, y: -dy } } : current);
    });
  },

  onGestureEnd(context) {
    // No commit here — placing a point is already live via `mutate` above,
    // and the path as a whole only commits on finish/close/double-click.
    if (context.state.handle) context.setState({ draft: context.state.draft, handle: null });
  },

  onDeactivate(context) {
    finishPath(context);
  },

  Overlay({ state, context }) {
    // Escape cancels the whole in-progress path — the pre-port code's own
    // global keydown handler did this by reading `pathDraft.current`
    // directly; now that the gesture lives in this tool's own state, the
    // tool owns the shortcut, the same move `vector.nodes` made for
    // Delete/Backspace. `context` is a dependency deliberately: see
    // `nodes.tsx`'s identical comment on why a stale closure here would be
    // the same class of bug as raster.move's ToolContext.state snapshot.
    useEffect(() => {
      if (!state.draft) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        deletePath(context);
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [state.draft, context]);
    return null;
  },
};

export default pen;
