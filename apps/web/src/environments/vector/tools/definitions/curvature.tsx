import { useEffect } from "react";
import { addShape, closestPointOnPath, createShape, emptyVectorStyle, insertPointOnPathSegment, recomputeSmoothHandles, resolveSnapForBounds, solidFill, solidStroke, toggleCornerSmooth, visibleGuides, type VectorDocumentState } from "@vravio/env-vector";
import { cssToColor } from "@vravio/kernel";
import type { VectorSnapshot } from "../../../../vector-commands";
import { hitTestNode } from "./nodes";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * Illustrator's Curvature Tool (Shift+~) — a genuinely different gesture from
 * `vector.pen`, not a variant of it: the owner's own side-by-side spec
 * (quoting Adobe's Pen/Curvature Tool documentation) is what this file
 * implements point for point, after `pen.tsx`'s doc comment already noted
 * the two tools solve "smooth through points" with opposite philosophies —
 *
 *   Pen:       anchor + you drag two handles out of it by hand.
 *   Curvature: anchor only — the tool recomputes a smooth curve through
 *              *every* point whenever any one of them is added, moved, or
 *              removed.
 *
 * That auto-recompute is `recomputeSmoothHandles` (`path-segment-ops.ts`),
 * factored out of the existing `toggleCornerSmooth` heuristic (tangent =
 * direction from the previous anchor to the next, handle length = a third of
 * the distance to each neighbour) rather than a second curve-fit algorithm.
 * Checked against real open-source code before trusting that heuristic here,
 * not just re-deriving it from memory (CLAUDE.md §1): paper.js's own
 * `Segment#smooth()` (github.com/paperjs/paper.js, `src/path/Segment.js`,
 * MIT) offers exactly two families for this same "auto-smooth through
 * points" problem — `catmull-rom` (a real Catmull-Rom spline, parameterized)
 * and `geometric` (its own comment: "a simple heuristic and empiric
 * geometric method", tangent = direction between neighbours, handle length
 * derived from the two adjacent segment lengths). Both are local, per-point
 * heuristics with no global solve — confirming that architecture (not a
 * specific formula to copy) is the standard approach for an interactive
 * tool. `toggleCornerSmooth`'s own formula is closer to a third convention
 * (each side's handle length is exactly a third of that side's own segment,
 * independent of the other side) that a plain-corner-to-smooth conversion
 * commonly uses — reused here instead of adding paper.js's specific
 * `geometric` constants as a second, differently-tuned heuristic living
 * alongside it in the same codebase, which the "single door" principle
 * (CLAUDE.md §4) argues against: one already-shipped, already-tested
 * formula for "what does a smooth point's handle look like" beats two
 * formulas nobody chose consciously between until they visibly disagreed.
 * A point is
 * "smooth" exactly when it carries a handle (the same test `toggleCornerSmooth`
 * already used); "corner" is a plain `{x, y}` with none, and this tool never
 * assigns one unless `Alt` is held or a double click asks for it — matching
 * the spec's own "Alt/Option — создать угловую точку/прямой сегмент" and
 * "Двойной клик — Smooth ↔ Corner".
 *
 * Implemented, matching the spec's own numbered list:
 *  - Click: place a point, smooth by default (#23-25).
 *  - Click + drag (on the point just placed, *or* on an existing point of
 *    any already-drawn path): move it, curve reflows live (#30). The spec's
 *    own "просто клик + перетаскивание" is one gesture for both cases here.
 *  - Alt/Option + click: place a corner point instead (#28-29).
 *  - Double click an anchor: toggle corner ↔ smooth, reusing `pen.tsx`'s own
 *    Ctrl+double-click convention verbatim (#26-27).
 *  - Click on an existing segment: insert a new, smooth point there (#32),
 *    via the same De Casteljau `insertPointOnPathSegment` `pen.tsx` already
 *    uses for the same gesture — one door, not two.
 *  - Click near the path's own first point: close it (#14), the same
 *    tolerance-based anchor hit-test `pen.tsx` uses, not a second one.
 *  - Escape: stop drawing (#33), same as Pen's own Escape.
 *
 * Deliberately not attempted, and left as an honest gap rather than a
 * half-right guess: resuming an existing open contour by clicking its
 * endpoint (`pen.tsx` has this; porting it here is straightforward but not
 * done yet), and `Delete` removing a selected point while this tool is
 * active (today that is `vector.nodes`' own gesture on a *selected node*,
 * which this tool has no concept of yet — a curvature point is never
 * individually selected, only ever the shape as a whole).
 */

const firstPointToleranceScreenPx = 6;

export interface CurvatureState {
  readonly draft: { readonly shapeId: string; readonly before: VectorSnapshot } | null;
  /** The point currently being dragged into position — either the one just
   * placed (`shapeId` matches the in-progress draft) or an existing point of
   * an already-committed path a plain click-drag grabbed. Distinct from
   * `draft`: dragging an existing point never starts a new path. */
  readonly moving: { readonly shapeId: string; readonly pointIndex: number; readonly before: VectorSnapshot | null } | null;
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

const empty: CurvatureState = { draft: null, moving: null, cursor: null };

export function finishCurvaturePath(context: ToolContext<CurvatureState>): void {
  const draft = context.state.draft;
  if (!draft) return;
  context.setState(empty);
  context.commitDrag(draft.before, "New Curve (Новая кривая)");
}

/** Right-click "Close Path" — joins the last point back to the first, then
 * finishes. Recomputes afterward: closing changes the first and last
 * points' own neighbours (each now wraps to the other), so their handles
 * need to reflect that instead of the open-path tangents they were placed
 * with. */
export function closeCurvaturePath(context: ToolContext<CurvatureState>): void {
  const draft = context.state.draft;
  if (!draft) return;
  context.mutate((document) => {
    const shape = document.shapes.find((item) => item.id === draft.shapeId);
    if (shape?.kind !== "path") return;
    shape.closed = true;
    shape.points = recomputeSmoothHandles(shape.points, true);
  });
  finishCurvaturePath(context);
}

export function deleteLastCurvaturePoint(context: ToolContext<CurvatureState>): void {
  const draft = context.state.draft;
  if (!draft) return;
  context.mutate((document) => {
    const shape = document.shapes.find((item) => item.id === draft.shapeId);
    if (shape?.kind === "path" && shape.points.length > 1) shape.points = recomputeSmoothHandles(shape.points.slice(0, -1), shape.closed);
  });
}

export function deleteCurvaturePath(context: ToolContext<CurvatureState>): void {
  const draft = context.state.draft;
  if (!draft) return;
  context.setState(empty);
  context.mutate((document) => {
    document.shapes = structuredClone(draft.before.shapes);
    document.activeShapeId = draft.before.activeShapeId;
    document.selection = draft.before.selection;
  });
}

export function hasCurvatureDraft(context: ToolContext<CurvatureState>): boolean {
  return context.state.draft !== null;
}

const curvature: VectorToolDefinition<CurvatureState> = {
  id: "vector.curvature",
  createState: () => empty,

  onPointerDown(context, pointer: ToolPointer) {
    const tolerance = firstPointToleranceScreenPx / context.viewport.zoom;

    // Double click an anchor toggles corner ↔ smooth, whether or not a path
    // is mid-draft — checked first because it is the one outcome that beats
    // every other click meaning below (placing a point, closing, dragging).
    if (pointer.detail >= 2) {
      const draftShape = context.state.draft ? context.document.shapes.find((item) => item.id === context.state.draft!.shapeId) : null;
      for (const shape of draftShape ? [draftShape] : context.document.shapes) {
        const hit = hitTestNode(shape, pointer.point, tolerance);
        if (hit && hit.part === "anchor") {
          void context.changeDocument("Convert Point (Преобразовать точку)", (document) => {
            const target = document.shapes.find((item) => item.id === shape.id);
            if (target?.kind !== "path") return false;
            target.points = recomputeSmoothHandles(toggleCornerSmooth(target.points, hit.pointIndex, target.closed), target.closed);
            return true;
          });
          return;
        }
      }
      return;
    }

    const draft = context.state.draft;
    if (draft) {
      const shape = context.document.shapes.find((item) => item.id === draft.shapeId);
      const firstPoint = shape?.kind === "path" ? shape.points[0] : undefined;

      // Clicking back on the path's own first point closes it — same
      // tolerance-based anchor hit-test as `vector.pen`'s own closing
      // gesture, not a second independently-guessed number.
      if (firstPoint && shape?.kind === "path" && shape.points.length > 1 && Math.hypot(pointer.point.x - firstPoint.x, pointer.point.y - firstPoint.y) <= tolerance) {
        closeCurvaturePath(context);
        return;
      }

      // Clicking an existing point of the in-progress path grabs it to drag
      // (the spec's own "клик + перетаскивание" applies here too, not only
      // to a freshly placed point).
      if (shape?.kind === "path") {
        const hit = hitTestNode(shape, pointer.point, tolerance);
        if (hit && hit.part === "anchor") {
          context.setState({ ...context.state, moving: { shapeId: shape.id, pointIndex: hit.pointIndex, before: null } });
          return;
        }
      }

      let placedPoint = pointer.point;
      if (!pointer.altKey) {
        const zeroSizeBounds = { x: placedPoint.x, y: placedPoint.y, width: 0, height: 0 };
        const snap = resolveSnapForBounds(zeroSizeBounds, context.snapping.radius, context.snapping.sources, {
          shapes: context.document.shapes, excludeIds: new Set([draft.shapeId]), gridSpacing: context.snapping.gridSpacing,
          documentWidth: context.document.width, documentHeight: context.document.height, guides: visibleGuides(context.document, context.document.activeArtboardId),
        });
        placedPoint = { x: placedPoint.x + snap.dx, y: placedPoint.y + snap.dy };
      }

      let pointIndex = -1;
      context.mutate((document: VectorDocumentState) => {
        const target = document.shapes.find((item) => item.id === draft.shapeId);
        if (target?.kind !== "path") return;
        // `recomputeSmoothHandles` only touches a point that *already*
        // carries a handle — its own contract, so a manually-converted
        // corner is never silently re-smoothed. A brand new point has
        // neither yet, which means it reads as a corner to that same check
        // unless it is seeded with a placeholder handle first — found live:
        // without this, every point ever placed stayed a hard corner and
        // the whole "auto-smooth through points" tool drew plain zigzags.
        // The placeholder's own (0, 0) value never actually renders: this
        // same call immediately overwrites it with the real tangent-based
        // handle via `smoothHandlesFor`, or leaves it exactly where a
        // still-neighbourless lone first point needs it — zero length, so
        // an as-yet-uncurved single point does not appear to have a curve
        // it does not have. `Alt` skips all of this: a corner point must
        // never gain a handle, seeded or real.
        const withNewPoint = [...target.points, pointer.altKey ? { x: placedPoint.x, y: placedPoint.y } : { x: placedPoint.x, y: placedPoint.y, handleOut: { x: 0, y: 0 } }];
        pointIndex = withNewPoint.length - 1;
        target.points = recomputeSmoothHandles(withNewPoint, target.closed);
      });
      if (pointIndex >= 0) context.setState({ ...context.state, moving: { shapeId: draft.shapeId, pointIndex, before: null }, cursor: placedPoint });
      return;
    }

    // No draft: a plain click grabs an existing point to drag (Adobe's own
    // "передвинуть точку"), a click on a segment inserts a new smooth point
    // there, and anything else starts a brand new path.
    for (const item of context.document.shapes) {
      const hit = hitTestNode(item, pointer.point, tolerance);
      if (hit && hit.part === "anchor") {
        context.setState({ ...context.state, moving: { shapeId: item.id, pointIndex: hit.pointIndex, before: context.snapshot() } });
        return;
      }
    }
    for (const item of context.document.shapes) {
      if (item.kind !== "path") continue;
      const closest = closestPointOnPath(item.points, item.closed, pointer.point.x, pointer.point.y);
      if (!closest || closest.distance > tolerance) continue;
      void context.changeDocument("Add Point (Добавить точку)", (document) => {
        const target = document.shapes.find((shape) => shape.id === item.id);
        if (target?.kind !== "path") return false;
        target.points = recomputeSmoothHandles(insertPointOnPathSegment(target.points, closest.segmentIndex, closest.t), target.closed);
        return true;
      });
      return;
    }

    const before = context.snapshot();
    const strokeWidth = typeof context.options.strokeWidth === "number" ? context.options.strokeWidth : 2;
    const shape = createShape("path", pointer.point.x, pointer.point.y, {
      ...emptyVectorStyle(),
      fills: [solidFill(cssToColor(context.foregroundColor))],
      strokes: [{ ...solidStroke(cssToColor(context.foregroundColor), strokeWidth), visible: false }],
    });
    // `moving` set to this brand-new first point too, not just later ones —
    // a click-drag on the very first click of a new path should reposition
    // it the same way every later point does, for the same consistency
    // `pen.tsx`'s own first click already gets a `handle` to drag out of.
    context.setState({ draft: { shapeId: shape.id, before }, moving: { shapeId: shape.id, pointIndex: 0, before: null }, cursor: pointer.point });
    context.mutate((document: VectorDocumentState) => {
      addShape(document, shape);
      // `createShape("path", ...)` gives the first point a bare `{x, y}` —
      // the same seeding this file's later points need and get (see the
      // long comment on the "draft exists" branch below) applies here too,
      // found only by checking the actual committed data live: without it,
      // this very first point can never pass `recomputeSmoothHandles`'s own
      // "already has a handle" gate, so it stays a hard corner forever no
      // matter how many smooth neighbours it later gets.
      if (!pointer.altKey) {
        const target = document.shapes.find((item) => item.id === shape.id);
        if (target?.kind === "path") target.points = [{ ...target.points[0]!, handleOut: { x: 0, y: 0 } }];
      }
    });
  },

  onPointerMove(context, pointer) {
    if (context.state.draft) context.setState({ ...context.state, cursor: pointer.point });
    const moving = context.state.moving;
    if (!moving) return;
    context.mutate((document: VectorDocumentState) => {
      const shape = document.shapes.find((item) => item.id === moving.shapeId);
      if (shape?.kind !== "path" || !shape.points[moving.pointIndex]) return;
      const moved = shape.points.map((point, index) => index === moving.pointIndex ? { ...point, x: pointer.point.x, y: pointer.point.y } : point);
      // A corner point (placed with Alt, or converted by a double click)
      // stays a corner while it moves — only its position changes, the
      // same "recompute skips points with no handle" rule everywhere else
      // in this file relies on.
      shape.points = recomputeSmoothHandles(moved, shape.closed);
    });
  },

  onGestureEnd(context) {
    const moving = context.state.moving;
    if (!moving) return;
    context.setState({ ...context.state, moving: null });
    // Dragging an existing, already-committed point (`before` captured at
    // pointer-down) is its own undo step. Dragging the point *just placed*
    // by this same click (`before: null`) is not — that whole point's
    // placement is still part of the path's own single "New Curve" commit
    // on finish, the same "no commit here, the path finishes as a whole"
    // rule `vector.pen`'s own `onGestureEnd` states for its handle drag.
    if (moving.before) context.commitDrag(moving.before, "Move Point (Переместить точку)");
  },

  onDeactivate(context) {
    finishCurvaturePath(context);
  },

  Overlay({ state, context }) {
    useEffect(() => {
      if (!state.draft) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        deleteCurvaturePath(context);
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [state.draft, context]);
    return null;
  },
};

export default curvature;
