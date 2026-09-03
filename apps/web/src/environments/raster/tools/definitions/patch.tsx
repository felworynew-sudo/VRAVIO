import { combineSelections, createPolygonSelection, patchFromSelection, selectionOutlinePath, type Point } from "@vravio/env-raster";
import type { RasterToolDefinition, ToolContext } from "../types";

/**
 * The patch tool: drag a selected region elsewhere on the canvas and it is
 * blended in with a Poisson solve, the same membrane `spotHeal` and the
 * restoring brush both use.
 *
 * Photoshop's Patch draws its own selection when there is none yet, then
 * patches when you drag inside one — the old switch fell back to lasso's
 * own drag machinery for that first half (`selectionGesture`, kept alive
 * in `RasterWorkspace.tsx` for this one caller after `marquee`/`lasso`
 * moved into the catalogue). A tool has no way to reach another tool's host
 * refs, so this is its own small lasso tracker rather than a shared one —
 * deliberately not the full `marquee-selection.tsx` machinery: the old
 * fallback never read Shift/Alt/Space either, always plain "replace".
 */

interface FallbackLasso {
  readonly pointerId: number;
  readonly points: readonly Point[];
}

interface Stroke {
  readonly pointerId: number;
  readonly before: Uint8ClampedArray;
  working: Uint8ClampedArray;
  curveStart: Point;
  pending: Point;
}

interface PatchState {
  readonly fallbackLasso: FallbackLasso | null;
  readonly stroke: Stroke | null;
}

const empty: PatchState = { fallbackLasso: null, stroke: null };

function applyPatch(context: ToolContext<PatchState>, stroke: Stroke, to: Point): void {
  const selection = context.selection;
  if (!selection) return;
  const offsetX = to.x - stroke.curveStart.x, offsetY = to.y - stroke.curveStart.y;
  const options = context.options;
  // Each frame patches the original, not the previous frame's result. Left
  // to accumulate, dragging a patch a hundred pixels applied it a hundred
  // times and the area turned to mush.
  stroke.working.set(stroke.before);
  patchFromSelection(stroke.working, context.document.width, context.document.height, context.paintMask ?? null, selection.bounds, offsetX, offsetY, Number(options.opacity ?? 100) / 100, (options.mode as "source" | "destination") ?? "source", Number(options.feather ?? 0));
  stroke.pending = to;
}

const patch: RasterToolDefinition<PatchState> = {
  id: "raster.patch",
  requiresRasterized: true,
  createState: () => empty,

  onPointerDown(context, pointer) {
    if (context.paintTarget.kind === "mask") return;
    if (context.activeLayer?.locked) return;
    context.capturePointer(pointer.pointerId);
    if (!context.selection) {
      context.setState({ fallbackLasso: { pointerId: pointer.pointerId, points: [pointer.point] }, stroke: null });
      return;
    }
    const before = context.layerPixels();
    context.setState({ fallbackLasso: null, stroke: { pointerId: pointer.pointerId, before, working: before.slice(), curveStart: pointer.point, pending: pointer.point } });
  },

  onPointerMove(context, pointer) {
    const state = context.state;
    if (state.fallbackLasso && state.fallbackLasso.pointerId === pointer.pointerId) {
      context.setState({ ...state, fallbackLasso: { ...state.fallbackLasso, points: [...state.fallbackLasso.points, pointer.point] } });
      return;
    }
    const stroke = state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    applyPatch(context, stroke, pointer.point);
    context.schedulePreview(stroke.working, "pixels", context.paintTarget.layerId, null);
  },

  onGestureEnd(context, pointer) {
    const state = context.state;
    if (state.fallbackLasso && state.fallbackLasso.pointerId === pointer.pointerId) {
      context.setState(empty);
      const points = state.fallbackLasso.points;
      const first = points[0]!;
      // A click that never became a drag draws nothing, as it does for
      // lasso itself — a one-pixel selection is never what anyone wanted.
      const travelled = Math.max(...points.map((item) => Math.hypot(item.x - first.x, item.y - first.y)), 0);
      if (travelled < 2) return;
      const feather = Number(context.options.feather ?? 0);
      const incoming = createPolygonSelection(context.document.width, context.document.height, points, feather);
      const combined = combineSelections(context.selection, incoming, context.document.width, context.document.height, "replace");
      void context.commitSelection(context.selection, combined, "Patch Selection (Выделение заплаткой)");
      return;
    }
    const stroke = state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    context.setState(empty);
    applyPatch(context, stroke, pointer.point);
    // The changed region is the selection itself, translated by the drag —
    // not a brush-stroke bounding box, which is what this tool has no use
    // for in the first place.
    const selection = context.selection;
    const pad = Number(context.options.feather ?? 0) + 2;
    const bounds = selection ? {
      x: selection.bounds.x + (stroke.pending.x - stroke.curveStart.x) - pad,
      y: selection.bounds.y + (stroke.pending.y - stroke.curveStart.y) - pad,
      width: selection.bounds.width + pad * 2,
      height: selection.bounds.height + pad * 2,
    } : null;
    void context.commit(stroke.before, stroke.working, "Patch (Заплатка)", "pixels", context.paintTarget.layerId, bounds);
  },

  onDeactivate(context) {
    const state = context.state;
    const stroke = state.stroke;
    if (stroke) {
      void context.commit(stroke.before, stroke.working, "Patch (Заплатка)", "pixels", context.paintTarget.layerId, null);
    }
    // A fallback lasso is a selection gesture, not a paint one — discarded
    // on a mid-drag tool switch, the same as marquee/lasso's own
    // onDeactivate, not committed the way a stroke is.
    if (state.fallbackLasso || state.stroke) context.setState(empty);
  },

  Overlay({ state, document, context }) {
    if (state.fallbackLasso) {
      return <svg className="selection-overlay" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline points={state.fallbackLasso.points.map((point) => `${point.x},${point.y}`).join(" ")}/>
      </svg>;
    }
    const stroke = state.stroke;
    const selection = context.selection;
    if (!stroke || !selection) return null;
    const offsetX = stroke.pending.x - stroke.curveStart.x, offsetY = stroke.pending.y - stroke.curveStart.y;
    if (offsetX === 0 && offsetY === 0) return null;
    const path = selectionOutlinePath(selection.mask, document.width, document.height);
    if (!path) return null;
    // Where the patch is reading from. The destination keeps its own
    // marching ants, so the pair shows both halves of the operation at
    // once — otherwise a drag looks like it is moving the selection.
    return <svg className="patch-source-overlay" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="patch-source-path" d={path} transform={`translate(${offsetX} ${offsetY})`}/>
    </svg>;
  },
};

export default patch;
