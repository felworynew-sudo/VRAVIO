import { useEffect } from "react";
import { addShape, closestPointOnPath, createShape, deletePointPreservingCurve, emptyVectorStyle, insertPointOnPathSegment, resolveSnapForBounds, solidFill, solidStroke, toggleCornerSmooth, type VectorDocumentState } from "@vravio/env-vector";
import { cssToColor } from "@vravio/kernel";
import type { VectorSnapshot } from "../../../../vector-commands";
import { applyNodeMove, hitTestNode, type NodePart } from "./nodes";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * Illustrator's pen: click to place a corner point, click-drag to pull a
 * symmetric Bézier handle out of the point just placed, double-click to
 * finish. Read off the pre-port `activeToolId === "vector.pen"` branch of
 * `onPointerDown`/`onPointerMove` plus the `pathDraft`/`penHandle` refs it
 * carried the gesture in.
 *
 * Gestures added 6 September 2026 (`docs/vector-plan.md` section 9, "Долг:
 * инструмент «Перо»", first priority): close-by-clicking-the-first-point,
 * a rubber-band preview of the next segment, `Shift` angle constraint, and
 * `Alt` handle-breaking — donors named in that section are Krita's Bézier
 * Curve Tool and Inkscape's `pen-tool.cpp`/`node-tool.cpp` (behaviour, not
 * code — both GPL). Inkscape closes a path by hit-testing the pointer
 * against a `SPDrawAnchor` at the path's own start point, not a guessed
 * screen-pixel radius; this file's `firstPointToleranceScreenPx` reuses
 * `vector.nodes`'s own anchor hit-tolerance constant (`nodes.tsx`'s
 * `tolerance = 6 / context.viewport.zoom`) for the same reason that file
 * gives it — one door, not two independently-guessed numbers meaning the
 * same "close enough to a point" — rather than inventing a second one.
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

const firstPointToleranceScreenPx = 6;

export interface PenState {
  readonly draft: { readonly shapeId: string; readonly before: VectorSnapshot } | null;
  readonly handle: { readonly shapeId: string; readonly pointIndex: number; readonly anchor: { readonly x: number; readonly y: number } } | null;
  /** The pointer's last known document-space position while a path is in
   * progress, tracked purely for the rubber-band preview in `Overlay` —
   * `onPointerMove` updates this even when no handle is being dragged
   * (hovering between clicks), which no other vector tool needs to do. */
  readonly cursor: { readonly x: number; readonly y: number } | null;
  /**
   * `Ctrl`/`Cmd` held down temporarily borrows `vector.nodes`'s own anchor/
   * handle drag — docs/vector-plan.md section 9, second priority ("Временный
   * Node Tool через Ctrl/Cmd, зажатый во время рисования пером"). Separate
   * from `handle` (which is Pen's own just-placed-point handle, always
   * mirrored/broken by Shift/Alt, never by a Ctrl check) so an in-progress
   * `draft`/`handle` gesture is left untouched underneath — releasing Ctrl
   * mid-drag does not need to "hand back" anything, because nothing about
   * the draft ever stopped existing.
   */
  readonly nodeEdit: { readonly shapeId: string; readonly pointIndex: number; readonly part: NodePart; readonly before: VectorSnapshot } | null;
}

const empty: PenState = { draft: null, handle: null, cursor: null, nodeEdit: null };

/** Rounds `angle` (radians) to the nearest multiple of 45° — `Shift`'s
 * constraint, both for a handle drag and for placing a new point, per
 * `docs/vector-plan.md`'s own spec for this gesture (45°, not the 15° some
 * other editors use — taken as given from that document, not re-derived
 * here). */
function snapAngleTo45Degrees(angle: number): number {
  const step = Math.PI / 4;
  return Math.round(angle / step) * step;
}

/** Applies `Shift`'s 45°-angle constraint to a vector `(dx, dy)`, keeping
 * its length unchanged — used both for the handle drag and for a new
 * point's placement relative to the path's last point. */
function constrainVectorTo45Degrees(dx: number, dy: number): { x: number; y: number } {
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  const angle = snapAngleTo45Degrees(Math.atan2(dy, dx));
  return { x: Math.cos(angle) * length, y: Math.sin(angle) * length };
}

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
    // `Ctrl`/`Cmd` temporarily borrows vector.nodes' own anchor/handle drag
    // — checked first, before any of Pen's own click handling, and against
    // *both* the shape currently being drawn (if any) and the document's
    // active shape, so this works whether or not a path is mid-draft. Falls
    // through to Pen's normal behaviour when the modifier is held but
    // nothing is actually under the pointer — holding Ctrl over empty
    // canvas must not silently swallow a click that would otherwise place
    // a point.
    if (pointer.ctrlKey || pointer.metaKey) {
      const tolerance = firstPointToleranceScreenPx / context.viewport.zoom;
      const draftShape = context.state.draft ? context.document.shapes.find((item) => item.id === context.state.draft!.shapeId) : null;
      const candidate = draftShape ?? context.activeShape;
      const hit = candidate ? hitTestNode(candidate, pointer.point, tolerance) : null;
      if (candidate && hit) {
        // `Ctrl` + double-click on the anchor itself (not a handle) toggles
        // corner ↔ smooth — docs/vector-plan.md section 9, third priority
        // ("Умное преобразование угловой/сглаженной точки, автосглаживание").
        // A one-shot `changeDocument`, not a drag: there is nothing to drag
        // to, the whole gesture is the toggle itself.
        if (hit.part === "anchor" && pointer.detail >= 2) {
          void context.changeDocument("Convert Point (Преобразовать точку)", (document) => {
            const target = document.shapes.find((shape) => shape.id === candidate.id);
            if (target?.kind !== "path") return false;
            target.points = toggleCornerSmooth(target.points, hit.pointIndex, target.closed);
            return true;
          });
          return;
        }
        context.setState({ ...context.state, nodeEdit: { shapeId: candidate.id, pointIndex: hit.pointIndex, part: hit.part, before: context.snapshot() } });
        return;
      }
    }
    const draft = context.state.draft;
    if (draft) {
      const { shapeId } = draft;
      const shape = context.document.shapes.find((item) => item.id === shapeId);
      const firstPoint = shape?.kind === "path" ? shape.points[0] : undefined;
      const lastPoint = shape?.kind === "path" ? shape.points[shape.points.length - 1] : undefined;

      // Clicking back on the path's own first point closes it — Inkscape's
      // `green_closed` state, reached by hit-testing the pointer against a
      // `SPDrawAnchor` there rather than requiring a pixel-perfect click on
      // the exact original coordinate. Needs at least 2 points already
      // placed: closing a single point onto itself is not a path.
      if (firstPoint && shape?.kind === "path" && shape.points.length > 1) {
        const toleranceDocumentUnits = firstPointToleranceScreenPx / context.viewport.zoom;
        if (Math.hypot(pointer.point.x - firstPoint.x, pointer.point.y - firstPoint.y) <= toleranceDocumentUnits) {
          closePath(context);
          return;
        }
      }

      let placedPoint = pointer.point;
      // `Shift` constrains the new segment to a 45°-multiple angle from the
      // path's last point — docs/vector-plan.md section 9, first priority.
      if (pointer.shiftKey && lastPoint) {
        const constrained = constrainVectorTo45Degrees(pointer.point.x - lastPoint.x, pointer.point.y - lastPoint.y);
        placedPoint = { x: lastPoint.x + constrained.x, y: lastPoint.y + constrained.y };
      } else {
        // Snapping — `context.snapping` is already threaded to every vector
        // tool (stage 5) but this file never read it; a zero-size bounds at
        // the click point reuses `resolveSnapForBounds` exactly the way
        // `vector.select`'s own drag does, rather than a second snap
        // implementation for a single point. Excludes this path's own
        // shape so a later point never snaps to an earlier segment of the
        // same in-progress path.
        const zeroSizeBounds = { x: placedPoint.x, y: placedPoint.y, width: 0, height: 0 };
        const snap = resolveSnapForBounds(zeroSizeBounds, context.snapping.radius, context.snapping.sources, {
          shapes: context.document.shapes, excludeIds: new Set([shapeId]), gridSpacing: context.snapping.gridSpacing,
          documentWidth: context.document.width, documentHeight: context.document.height,
        });
        placedPoint = { x: placedPoint.x + snap.dx, y: placedPoint.y + snap.dy };
      }

      let pointIndex = -1;
      context.mutate((document: VectorDocumentState) => {
        const target = document.shapes.find((item) => item.id === shapeId);
        if (target?.kind === "path") { target.points = [...target.points, { x: placedPoint.x, y: placedPoint.y }]; pointIndex = target.points.length - 1; }
      });
      if (pointIndex >= 0) context.setState({ draft, handle: { shapeId, pointIndex, anchor: placedPoint }, cursor: placedPoint, nodeEdit: null });
      // A double-click finishes the path — the same `event.detail >= 2` test
      // the pre-port code read straight off the native PointerEvent.
      if (pointer.detail >= 2) finishPath(context);
      return;
    }
    const before = context.snapshot();

    // Clicking an existing point of an already-committed path deletes it,
    // without leaving the Pen tool — docs/vector-plan.md section 9, second
    // priority ("удаление — кликом по существующему узлу, без выхода из
    // инструмента «Перо»"). Checked *before* the continuation case below,
    // and explicitly excludes the last point of an open path (that click
    // means "resume drawing here", not "delete this point" — Illustrator
    // draws the same distinction between an open path's endpoint and any
    // other anchor). A path with only 2 points left has nothing sensible
    // left to delete down to (a 1-point "path" is not a shape); deleting
    // there removes the whole shape instead, the same floor `deleteLastPoint`
    // already respects for a path still being drawn.
    const toleranceDocumentUnitsForDelete = firstPointToleranceScreenPx / context.viewport.zoom;
    for (const item of context.document.shapes) {
      if (item.kind !== "path") continue;
      const isContinuableEndpoint = (index: number) => !item.closed && index === item.points.length - 1 && item.points.length >= 2;
      const hitIndex = item.points.findIndex((point, index) => !isContinuableEndpoint(index) && Math.hypot(pointer.point.x - point.x, pointer.point.y - point.y) <= toleranceDocumentUnitsForDelete);
      if (hitIndex < 0) continue;
      if (item.points.length <= 2) {
        void context.changeDocument("Delete Point (Удалить точку)", (document) => {
          const index = document.shapes.findIndex((shape) => shape.id === item.id);
          if (index < 0) return false;
          document.shapes = document.shapes.filter((shape) => shape.id !== item.id);
          return true;
        });
      } else {
        void context.changeDocument("Delete Point (Удалить точку)", (document) => {
          const target = document.shapes.find((shape) => shape.id === item.id);
          if (target?.kind !== "path") return false;
          // `deletePointPreservingCurve`, not a plain `.filter()` — section
          // 9's third priority ("удаление узла с сохранением кривизны
          // контура"), see that function's own doc comment for exactly what
          // "preserving" means here (a documented heuristic, not an exact
          // curvature fit).
          target.points = deletePointPreservingCurve(target.points, hitIndex, target.closed);
          return true;
        });
      }
      return;
    }

    // Clicking near the open end of an existing path continues it instead
    // of always starting a new one — docs/vector-plan.md section 9, second
    // priority ("продолжение существующего открытого контура кликом по его
    // концу"). Only the *last*-point end is picked up here: prepending at
    // the first-point end (which would need reversing the point order and
    // swapping each point's handleIn/handleOut) and joining two separate
    // open contours into one are both still open — see that section's own
    // notes. A closed path or one with only one point (nothing meaningfully
    // "open" to continue) is skipped.
    const toleranceDocumentUnits = firstPointToleranceScreenPx / context.viewport.zoom;
    const continuation = context.document.shapes.find((item) => {
      if (item.kind !== "path" || item.closed || item.points.length < 2) return false;
      const last = item.points[item.points.length - 1]!;
      return Math.hypot(pointer.point.x - last.x, pointer.point.y - last.y) <= toleranceDocumentUnits;
    });
    if (continuation?.kind === "path") {
      // The click that resumes an open path only *selects* it to keep
      // drawing on — it does not itself add a point at (essentially) the
      // same spot the existing last point already occupies. The handle
      // anchors on that existing last point so a click-drag here can still
      // pull a new handle out of it, mirroring what a click-drag on any
      // other already-placed point does.
      const lastIndex = continuation.points.length - 1;
      const lastPoint = continuation.points[lastIndex]!;
      context.setState({ draft: { shapeId: continuation.id, before }, handle: { shapeId: continuation.id, pointIndex: lastIndex, anchor: { x: lastPoint.x, y: lastPoint.y } }, cursor: { x: lastPoint.x, y: lastPoint.y }, nodeEdit: null });
      return;
    }

    // Clicking on a segment (not one of its endpoints — those are the two
    // cases above) inserts a real new anchor there, via De Casteljau
    // subdivision so a curved segment keeps its exact shape either side of
    // the new point — docs/vector-plan.md section 9, second priority
    // ("Добавление узла кликом по существующему сегменту"). Geometry lives
    // in `path-segment-ops.ts`, shared with whatever `vector.nodes` gesture
    // eventually wants the same insertion, not reimplemented here.
    for (const item of context.document.shapes) {
      if (item.kind !== "path") continue;
      const closest = closestPointOnPath(item.points, item.closed, pointer.point.x, pointer.point.y);
      if (!closest || closest.distance > toleranceDocumentUnitsForDelete) continue;
      void context.changeDocument("Add Point (Добавить точку)", (document) => {
        const target = document.shapes.find((shape) => shape.id === item.id);
        if (target?.kind !== "path") return false;
        target.points = insertPointOnPathSegment(target.points, closest.segmentIndex, closest.t);
        return true;
      });
      return;
    }

    // "strokeWidth" is vector.pen's own option; the pre-port code hardcoded
    // 2 regardless of what the panel showed — the dead-checkbox CLAUDE.md §3
    // rules out. A freshly drawn path still has no *visible* stroke (matches
    // Illustrator: a bare pen stroke is unstyled until Properties sets one,
    // and this project's own Properties panel — DockLayout.tsx — is exactly
    // where that stroke gets turned on) — but stage 6's stacked-appearance
    // model has nowhere to "remember a width with no stroke" the way the old
    // single `strokeWidth` field could sit next to a null `stroke`. A stroke
    // layer that already exists, already has the configured width, and is
    // simply `visible: false` is the same idea using the model's own
    // generic on/off flag: "turn the stroke on" in the panel becomes
    // flipping that flag, not inventing a stroke from nothing.
    const strokeWidth = typeof context.options.strokeWidth === "number" ? context.options.strokeWidth : 2;
    const shape = createShape("path", pointer.point.x, pointer.point.y, {
      ...emptyVectorStyle(),
      fills: [solidFill(cssToColor(context.foregroundColor))],
      strokes: [{ ...solidStroke(cssToColor(context.foregroundColor), strokeWidth), visible: false }],
    });
    context.setState({ draft: { shapeId: shape.id, before }, handle: { shapeId: shape.id, pointIndex: 0, anchor: pointer.point }, cursor: pointer.point, nodeEdit: null });
    context.mutate((document: VectorDocumentState) => addShape(document, shape));
  },

  onPointerMove(context, pointer) {
    const nodeEdit = context.state.nodeEdit;
    if (nodeEdit) {
      context.mutate((document) => applyNodeMove(document, nodeEdit.shapeId, nodeEdit.pointIndex, nodeEdit.part, pointer.point, !pointer.altKey));
      return;
    }
    if (context.state.draft) context.setState({ ...context.state, cursor: pointer.point });
    const handle = context.state.handle;
    if (!handle) return;
    const { shapeId, pointIndex, anchor } = handle;
    let dx = pointer.point.x - anchor.x, dy = pointer.point.y - anchor.y;
    // Below this, a click reads as a corner point, not an accidental one-pixel drag.
    if (Math.hypot(dx, dy) < 1) return;
    // `Shift` constrains the handle's own angle to a 45°-multiple, same
    // helper as the segment-placement constraint above.
    if (pointer.shiftKey) { const constrained = constrainVectorTo45Degrees(dx, dy); dx = constrained.x; dy = constrained.y; }
    // `Alt` breaks the handle from its mirror — the point becomes a corner
    // with independent curvature on each side, exactly `vector.nodes`'
    // own `mirror = !pointer.altKey` convention (`nodes.tsx`), reused here
    // rather than a second, differently-named way of saying the same thing.
    const mirror = !pointer.altKey;
    context.mutate((document: VectorDocumentState) => {
      const shape = document.shapes.find((item) => item.id === shapeId);
      if (shape?.kind === "path" && shape.points[pointIndex]) shape.points = shape.points.map((current, index) => index === pointIndex ? { ...current, handleOut: { x: dx, y: dy }, ...(mirror ? { handleIn: { x: -dx, y: -dy } } : {}) } : current);
    });
  },

  onGestureEnd(context) {
    const nodeEdit = context.state.nodeEdit;
    if (nodeEdit) {
      context.setState({ ...context.state, nodeEdit: null });
      context.commitDrag(nodeEdit.before, "Edit Path (Изменить контур)");
      return;
    }
    // No commit here — placing a point is already live via `mutate` above,
    // and the path as a whole only commits on finish/close/double-click.
    if (context.state.handle) context.setState({ ...context.state, handle: null });
  },

  onDeactivate(context) {
    finishPath(context);
  },

  /**
   * Five genuinely different outcomes share this one tool's click, and a
   * hover-only preview of which one is about to happen is exactly what
   * docs/vector-plan.md section 9's "Состояния курсора" asks for. Mirrors
   * `onPointerDown`'s own priority order (Ctrl node-edit → close → delete →
   * continue → add-on-segment → new point) without mutating anything — a
   * read-only, best-effort echo of that logic, not a shared implementation
   * of it: the two must be kept in step by hand if one changes, an accepted
   * cost here because this function can be *wrong* far more cheaply than
   * `onPointerDown` can (worst case, a stale cursor hint for one frame; the
   * click itself always re-derives the real answer from scratch).
   *
   * Cursor choices are approximations — no CSS native cursor keyword means
   * "will close this path" or "will delete this point" — but a wrong-shaped
   * hint from the browser's own cursor set beats no hint at all: `grab` for
   * anything node-tool-like (Ctrl-editing, resuming an open contour),
   * `alias` for closing (most editors already use it for "attach/loop"),
   * `not-allowed` for delete, `copy` for adding a node, `undefined` (falls
   * back to the static `crosshair`) for placing an ordinary new point.
   */
  cursorFor(context, pointer) {
    const tolerance = firstPointToleranceScreenPx / context.viewport.zoom;
    if (pointer.ctrlKey || pointer.metaKey) {
      const draftShape = context.state.draft ? context.document.shapes.find((item) => item.id === context.state.draft!.shapeId) : null;
      const candidate = draftShape ?? context.activeShape;
      if (candidate && hitTestNode(candidate, pointer.point, tolerance)) return "grab";
    }
    const draft = context.state.draft;
    if (draft) {
      const shape = context.document.shapes.find((item) => item.id === draft.shapeId);
      const firstPoint = shape?.kind === "path" ? shape.points[0] : undefined;
      if (firstPoint && shape?.kind === "path" && shape.points.length > 1 && Math.hypot(pointer.point.x - firstPoint.x, pointer.point.y - firstPoint.y) <= tolerance) return "alias";
      return undefined;
    }
    for (const item of context.document.shapes) {
      if (item.kind !== "path") continue;
      const isContinuableEndpoint = (index: number) => !item.closed && index === item.points.length - 1 && item.points.length >= 2;
      if (item.points.some((point, index) => !isContinuableEndpoint(index) && Math.hypot(pointer.point.x - point.x, pointer.point.y - point.y) <= tolerance)) return "not-allowed";
    }
    const continuation = context.document.shapes.some((item) => item.kind === "path" && !item.closed && item.points.length >= 2 && Math.hypot(pointer.point.x - item.points[item.points.length - 1]!.x, pointer.point.y - item.points[item.points.length - 1]!.y) <= tolerance);
    if (continuation) return "grab";
    for (const item of context.document.shapes) {
      if (item.kind !== "path") continue;
      const closest = closestPointOnPath(item.points, item.closed, pointer.point.x, pointer.point.y);
      if (closest && closest.distance <= tolerance) return "copy";
    }
    return undefined;
  },

  Overlay({ state, context, document }) {
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

    if (!state.draft || !state.cursor) return null;
    const shape = document.shapes.find((item) => item.id === state.draft!.shapeId);
    if (shape?.kind !== "path" || shape.points.length === 0) return null;
    const lastPoint = shape.points[shape.points.length - 1]!;
    // The rubber-band preview: a straight line if the last point has no
    // outgoing handle yet, a real cubic curve if it does (matching what
    // committing the segment would actually draw) — Inkscape's own pen
    // tool redraws this "red curve" on every pointer move for the same
    // reason: the user needs to see the segment before deciding to click.
    const zoom = context.viewport.zoom;
    const path = lastPoint.handleOut
      ? `M ${lastPoint.x} ${lastPoint.y} C ${lastPoint.x + lastPoint.handleOut.x} ${lastPoint.y + lastPoint.handleOut.y}, ${state.cursor.x} ${state.cursor.y}, ${state.cursor.x} ${state.cursor.y}`
      : `M ${lastPoint.x} ${lastPoint.y} L ${state.cursor.x} ${state.cursor.y}`;
    return <path className="vector-pen-rubber-band" d={path} fill="none" strokeWidth={1 / zoom}/>;
  },
};

export default pen;
