import { appendLassoPoint, combineSelections, createEllipseSelection, createPolygonSelection, createRectangleSelection, marqueeCorners, marqueeRect, translateSelection, type PixelSelection, type Point, type SelectionCombineMode } from "@vravio/env-raster";
import { MarchingAnts } from "../../../marching-ants";
import type { RasterToolDefinition, ToolContext, ToolPointer } from "./types";

/**
 * The shape rectangle, ellipse and lasso selection share.
 *
 * In RasterWorkspace today these are one state machine (`selectionGesture`)
 * keyed by a `kind` field, not three independent branches — the drag
 * tracking, the feather lookup, the combine-mode arithmetic and the
 * click-without-drag-deselects rule are identical for all three, and only
 * the shape math at the end differs (`createRectangleSelection` versus
 * `createEllipseSelection` versus `createPolygonSelection`). Porting one
 * alone would mean duplicating that machinery into a single tool file, the
 * same reasoning that kept the brush family together — see the note at
 * stage 5's reordering in docs/migration-plan.md. So this is one
 * implementation, instantiated three times by the three files under
 * definitions/ that each name their own id and shape.
 */

export type MarqueeKind = "rectangle" | "ellipse" | "lasso";

interface DragState {
  readonly pointerId: number;
  readonly from: Point;
  readonly base: PixelSelection;
  /** What is being shown while the drag is in progress — read by
   * RasterWorkspace to stand in for the committed selection's marching ants,
   * the same way `marqueePreview` did before this moved into a tool. */
  readonly preview: PixelSelection | null;
}

interface DrawState {
  readonly pointerId: number;
  from: Point;
  current: Point;
  /** Only meaningful for lasso; empty otherwise. */
  points: readonly Point[];
  readonly mode: SelectionCombineMode;
  /** Where Space was when it started being held mid-drag, so the marquee
   * slides by how far the pointer has moved since — not by an accumulating
   * per-frame delta, which would drift. */
  spaceAnchor: Point | null;
  /** Whether Shift/Alt are down *right now*, refreshed on every pointer move — unlike `mode`
   * (captured once, at drag start, since the two keys mean something different there: which
   * selection combine op this drag is), the square/from-centre reading has to track the keys
   * live, or holding Shift only partway through a drag would never square up the preview until
   * release — see `Overlay`'s own comment on why it needs these two booleans at all. */
  shiftKey: boolean;
  altKey: boolean;
}

export interface MarqueeState {
  drag: DragState | null;
  draw: DrawState | null;
}

const empty: MarqueeState = { drag: null, draw: null };

function modeFromModifiers(pointer: ToolPointer): SelectionCombineMode {
  return pointer.shiftKey && pointer.altKey ? "intersect" : pointer.shiftKey ? "add" : pointer.altKey ? "subtract" : "replace";
}


function shapeFrom(kind: MarqueeKind, draw: DrawState, width: number, height: number, feather: number, pointer: ToolPointer): PixelSelection {
  const corners = marqueeCorners(draw.from.x, draw.from.y, draw.current.x, draw.current.y, { square: pointer.shiftKey, fromCentre: pointer.altKey });
  if (kind === "lasso") return createPolygonSelection(width, height, draw.points, feather);
  if (kind === "ellipse") return createEllipseSelection(width, height, corners.fromX, corners.fromY, corners.toX, corners.toY, feather);
  return createRectangleSelection(width, height, corners.fromX, corners.fromY, corners.toX, corners.toY, feather);
}

export function createMarqueeTool(id: string, kind: MarqueeKind): RasterToolDefinition<MarqueeState> {
  return {
    id,
    createState: () => empty,

    onPointerDown(context, pointer) {
      const { document, selection } = context;
      // Dragging from inside an existing selection moves the marquee itself,
      // leaving the pixels alone — the Move tool is what moves those.
      // Without this a selection can only ever be redrawn, never adjusted.
      const inside = selection && !pointer.shiftKey && !pointer.altKey
        && pointer.point.x >= 0 && pointer.point.y >= 0 && pointer.point.x < document.width && pointer.point.y < document.height
        && selection.mask[Math.floor(pointer.point.y) * document.width + Math.floor(pointer.point.x)]! > 0;
      if (inside && selection) {
        context.capturePointer(pointer.pointerId);
        context.setState({ drag: { pointerId: pointer.pointerId, from: pointer.point, base: selection, preview: null }, draw: null });
        return;
      }

      context.capturePointer(pointer.pointerId);
      // Photoshop reads Shift and Alt at the moment the drag begins to decide
      // how the new selection combines with the old one. The same keys
      // pressed later, mid-drag, mean something else entirely — square, and
      // from-centre — so the mode is captured here rather than looked up
      // when the drag ends.
      const mode = pointer.shiftKey && pointer.altKey ? "intersect" : pointer.shiftKey ? "add" : pointer.altKey ? "subtract" : (String(context.options.mode ?? "replace") as SelectionCombineMode);
      context.setState({ drag: null, draw: { pointerId: pointer.pointerId, from: pointer.point, current: pointer.point, points: [pointer.point], mode, spaceAnchor: null, shiftKey: pointer.shiftKey, altKey: pointer.altKey } });
    },

    onPointerMove(context, pointer) {
      const { drag, draw } = context.state;
      if (drag && drag.pointerId === pointer.pointerId) {
        const moved = translateSelection(drag.base, context.document.width, context.document.height, pointer.point.x - drag.from.x, pointer.point.y - drag.from.y);
        context.setState({ drag: { ...drag, preview: moved }, draw: null });
        return;
      }
      if (draw && draw.pointerId === pointer.pointerId) {
        // Holding Space mid-drag slides the whole marquee instead of resizing
        // it — the only way to correct a start point without beginning again.
        if (context.spaceHeld) {
          const anchor = draw.spaceAnchor ?? pointer.point;
          const dx = pointer.point.x - anchor.x, dy = pointer.point.y - anchor.y;
          context.setState({ drag: null, draw: { ...draw, from: { x: draw.from.x + dx, y: draw.from.y + dy }, current: { x: draw.current.x + dx, y: draw.current.y + dy }, spaceAnchor: pointer.point, shiftKey: pointer.shiftKey, altKey: pointer.altKey } });
          return;
        }
        const points = kind === "lasso" ? appendLassoPoint(draw.points, pointer.point) : draw.points;
        context.setState({ drag: null, draw: { ...draw, current: pointer.point, points, spaceAnchor: null, shiftKey: pointer.shiftKey, altKey: pointer.altKey } });
      }
    },

    onGestureEnd(context, pointer) {
      const { drag, draw } = context.state;
      if (drag && drag.pointerId === pointer.pointerId) {
        context.setState(empty);
        if (drag.preview) void context.commitSelection(drag.base, drag.preview, "Move Selection (Перемещение выделения)");
        return;
      }
      if (!draw || draw.pointerId !== pointer.pointerId) return;
      context.setState(empty);

      // The spacing floor above can leave the release point itself unrecorded
      // — the last few sub-threshold pixels of the gesture never crossed
      // `LASSO_POINT_SPACING`. Closing the loop on a vertex short of where the
      // pointer actually came up would nick a sliver off the traced shape, so
      // it is forced in here with a zero minimum spacing.
      const finalPoints = kind === "lasso" ? appendLassoPoint(draw.points, pointer.point, 0) : draw.points;
      const finalDraw = draw.points === finalPoints ? draw : { ...draw, points: [...finalPoints] };

      // A click that never became a drag deselects, as it does in Photoshop.
      // Taken literally it described a one-pixel selection, which is never
      // what anyone wanted and left a selection nothing else would work
      // outside of.
      const travelled = kind === "lasso"
        ? Math.max(...finalDraw.points.map((point) => Math.hypot(point.x - draw.from.x, point.y - draw.from.y)), 0)
        : Math.hypot(draw.current.x - draw.from.x, draw.current.y - draw.from.y);
      if (travelled < 2) {
        if (context.selection) void context.commitSelection(context.selection, null, "Deselect (Снять выделение)");
        return;
      }

      const feather = Number(context.options.feather ?? 0);
      const incoming = shapeFrom(kind, finalDraw, context.document.width, context.document.height, feather, pointer);
      // A selection is a region of the canvas, not of the layer: selecting
      // empty space is how anything gets painted into it. Confining it to
      // opaque pixels belongs at the moment something is moved or
      // transformed, where there has to be content to move — not here.
      const combined = combineSelections(context.selection, incoming, context.document.width, context.document.height, draw.mode);
      void context.commitSelection(context.selection, combined, "Marquee Selection (Выделение)");
    },

    onDeactivate(context) {
      if (context.state.drag || context.state.draw) context.setState(empty);
    },

    Overlay({ state, document, context }) {
      const draw = state.draw;
      if (!draw) return null;
      const rect = kind === "lasso"
        ? (() => {
          const xs = draw.points.map((point) => point.x), ys = draw.points.map((point) => point.y);
          const left = Math.min(...xs), top = Math.min(...ys);
          return { x: left, y: top, width: Math.max(1, Math.max(...xs) - left), height: Math.max(1, Math.max(...ys) - top) };
        })()
        // `{ square, fromCentre }` here, not the default `{}` this used to call with — without
        // it the live marching-ants preview stayed a plain unconstrained rectangle for the whole
        // drag no matter how Shift/Alt were held, only snapping to a square/circle-from-centre
        // shape at the very last frame (`shapeFrom`, called at `onGestureEnd`, already read the
        // same two options correctly) — the preview and the shape it committed visibly disagreed
        // the entire time the pointer was still down.
        : marqueeRect(draw.from.x, draw.from.y, draw.current.x, draw.current.y, { square: draw.shiftKey, fromCentre: draw.altKey });
      if (rect.width <= 0 || rect.height <= 0) return null;

      // The same marching ants the committed selection gets: in Photoshop the shape being
      // dragged and the shape you end up with look alike, and having two different edge
      // styles for the same thing was only ever an accident of them being drawn in
      // different files. `MarchingAnts` also owns the screen-constant widths, which this
      // SVG needs because it sits inside .raster-stage and the zoom scales it.
      return <svg className="selection-overlay" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
        <MarchingAnts zoom={context.viewport.zoom}>
          {kind === "lasso"
            ? <polyline points={draw.points.map((point) => `${point.x},${point.y}`).join(" ")} />
            : kind === "ellipse"
              ? <ellipse cx={rect.x + rect.width / 2} cy={rect.y + rect.height / 2} rx={rect.width / 2} ry={rect.height / 2} />
              : <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} />}
        </MarchingAnts>
      </svg>;
    },
  };
}
