import { cloneDab, cloneStrokeSegment, unionRect, type Point, type RasterRect } from "@vravio/env-raster";
import type { RasterToolDefinition, ToolContext } from "../types";

/**
 * The clone stamp: Alt-click sets where it reads from, then every stroke
 * copies pixels from a point offset the same distance away from wherever
 * the stroke paints.
 *
 * Never touches a mask (there is nothing to sample a source from in a
 * black-and-white threshold buffer) — the same restriction the tonal
 * tools have, for the same reason. The source point and its offset from
 * the current stroke live on `ToolContext` rather than in this tool's own
 * state: the workspace's own cursor crosshair reads them on every pointer
 * move regardless of which tool is active, and "registered" alignment
 * means the offset a stroke computed has to survive into the next one, the
 * way `lastStrokePoint` already does for Shift-click.
 */

interface Stroke {
  readonly pointerId: number;
  readonly before: Uint8ClampedArray;
  working: Uint8ClampedArray;
  curveStart: Point;
  pending: Point;
  dirty: RasterRect | null;
  strokeBounds: RasterRect | null;
  readonly sourceOffsetX: number;
  readonly sourceOffsetY: number;
}

interface CloneState {
  readonly stroke: Stroke | null;
}

const empty: CloneState = { stroke: null };

function resolvedOptions(options: Readonly<Record<string, string | number | boolean>>) {
  return {
    size: Number(options.size ?? 24),
    opacity: Number(options.opacity ?? 100) / 100,
    hardness: Number(options.hardness ?? 82) / 100,
    roundness: Number(options.roundness ?? 100) / 100,
    angle: Number(options.angle ?? 0),
    spacing: Number(options.spacing ?? 12) / 100,
    alignMode: String(options.alignMode ?? "registered"),
  };
}

/**
 * Extends the stroke to `point` — ported exactly from the old
 * `appendBrushPoint`'s clone branch, lag included: the segment actually
 * drawn is `curveStart -> pending` (the *previous* call's numbers), not
 * `curveStart -> point`. `point` and the midpoint `end` only ever decide
 * where `curveStart`/`pending` land for the *next* call. That means the
 * true final point of a stroke is never itself the target of a draw call —
 * only ever a `pending` some later call draws *up to* — which is exactly
 * how the old code behaved too, not a gap this port introduces.
 */
function appendPoint(context: ToolContext<CloneState>, stroke: Stroke, point: Point): void {
  if (Math.hypot(point.x - stroke.pending.x, point.y - stroke.pending.y) < 0.05) return;
  const end: Point = { x: (stroke.pending.x + point.x) / 2, y: (stroke.pending.y + point.y) / 2, pressure: ((stroke.pending.pressure ?? 1) + (point.pressure ?? 1)) / 2 };
  const o = resolvedOptions(context.options);
  cloneStrokeSegment(stroke.working, context.document.width, context.document.height, stroke.curveStart, stroke.pending, stroke.sourceOffsetX, stroke.sourceOffsetY, o.size, o.opacity, context.paintMask, o.hardness, o.roundness, o.angle, true, false, stroke.before, o.spacing);
  const pad = o.size / 2 + 2;
  stroke.dirty = unionRect(stroke.dirty, stroke.curveStart.x, stroke.curveStart.y, stroke.pending.x, stroke.pending.y, pad);
  stroke.dirty = unionRect(stroke.dirty, point.x, point.y, end.x, end.y, pad);
  stroke.strokeBounds = unionRect(stroke.strokeBounds, stroke.dirty.x, stroke.dirty.y, stroke.dirty.x + stroke.dirty.width, stroke.dirty.y + stroke.dirty.height, 0);
  stroke.curveStart = end;
  stroke.pending = point;
}

const clone: RasterToolDefinition<CloneState> = {
  id: "raster.clone",
  requiresRasterized: true,
  createState: () => empty,

  onPointerDown(context, pointer) {
    if (context.paintTarget.kind === "mask") return;
    if (pointer.altKey) {
      context.setCloneSource(pointer.point);
      context.setCloneOffset(null);
      return;
    }
    if (context.activeLayer?.locked) return;
    const source = context.cloneSource;
    if (!source) return;
    context.capturePointer(pointer.pointerId);

    const o = resolvedOptions(context.options);
    let offset = context.cloneOffset;
    if (!offset || o.alignMode === "none") {
      offset = { x: source.x - pointer.point.x, y: source.y - pointer.point.y };
      context.setCloneOffset(offset);
    }
    const key = context.paintTarget.layerId;
    const before = context.layerPixels();
    const working = before.slice();

    const last = context.lastStrokePoint;
    const shiftFrom = pointer.shiftKey && last?.toolId === clone.id && last.layerId === key ? last.point : null;
    if (shiftFrom) {
      cloneStrokeSegment(working, context.document.width, context.document.height, shiftFrom, pointer.point, offset.x, offset.y, o.size, o.opacity, context.paintMask, o.hardness, o.roundness, o.angle, true, false, before, o.spacing);
      context.setLastStrokePoint({ toolId: clone.id, layerId: key, point: pointer.point });
      context.schedulePreview(working, "pixels", key, null);
      void context.commit(before, working, "Clone Line (Линия штампа)");
      return;
    }

    cloneDab(working, context.document.width, context.document.height, pointer.point.x + offset.x, pointer.point.y + offset.y, pointer.point.x, pointer.point.y, o.size, o.opacity, o.hardness, context.paintMask, o.roundness, o.angle, true, false, before);
    context.schedulePreview(working, "pixels", key, null);
    context.setState({ stroke: { pointerId: pointer.pointerId, before, working, curveStart: pointer.point, pending: pointer.point, dirty: null, strokeBounds: null, sourceOffsetX: offset.x, sourceOffsetY: offset.y } });
  },

  onPointerMove(context, pointer) {
    const stroke = context.state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    appendPoint(context, stroke, pointer.point);
    context.schedulePreview(stroke.working, "pixels", context.paintTarget.layerId, stroke.dirty);
    stroke.dirty = null;
  },

  onGestureEnd(context, pointer) {
    const stroke = context.state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    appendPoint(context, stroke, pointer.point);
    context.setLastStrokePoint({ toolId: clone.id, layerId: context.paintTarget.layerId, point: stroke.pending });
    void context.commit(stroke.before, stroke.working, "Clone (Штамп)", "pixels", context.paintTarget.layerId, stroke.strokeBounds);
    context.setState(empty);
  },

  onDeactivate(context) {
    const stroke = context.state.stroke;
    if (!stroke) return;
    void context.commit(stroke.before, stroke.working, "Clone (Штамп)", "pixels", context.paintTarget.layerId, stroke.strokeBounds);
    context.setState(empty);
  },
};

export default clone;
