import { drawDab, drawQuadraticStrokeSegment, parseHexColor, sampleAverage, toHexColor, unionRect, type Point, type RasterRect } from "@vravio/env-raster";
import { locksRefuse } from "./lock-guard";
import type { PaintTarget, RasterToolDefinition, ToolContext, ToolPointer } from "./types";

/**
 * The dragged-stroke shape brush, pencil, highlighter and eraser share.
 *
 * All four run the exact same paint primitives — a dab on press, a
 * quadratic-curve segment per move, one more segment closing to the release
 * point — differing only in two things a `RasterWorkspace.tsx` switch used
 * to read off `activeToolId`: whether the stroke erases, and whether its
 * hardness is pinned to a hard edge instead of the `hardness` option
 * (pencil's only distinction — see `docs/migration-plan.md` stage 5).
 * Highlighter is not a third case: it is `brush` with a lower default
 * opacity, a `tools.ts` descriptor fact, not a logic one.
 *
 * Unlike the marquee family this state is not committed once at gesture end
 * — it is painted live, straight to the canvas outside React
 * (`context.schedulePreview`), because a dragged stroke can produce
 * hundreds of pointer-move frames a second and routing each through
 * `setState` would undo RASTER-PAINT-002's 428ms→14ms compositing fix (see
 * `types.ts`'s note on `schedulePreview`). The stroke's own mutable fields
 * (`working`, `curveStart`, `pending`, `dirty`) are therefore mutated in
 * place across repeated `onPointerMove` calls rather than replaced through
 * `setState` — the same trade the old `gesture` ref made, kept because
 * nothing about moving it into a tool changes why it was made.
 */

interface Stroke {
  readonly pointerId: number;
  readonly before: Uint8ClampedArray;
  working: Uint8ClampedArray;
  curveStart: Point;
  pending: Point;
  dirty: RasterRect | null;
  strokeBounds: RasterRect | null;
  readonly target: PaintTarget["kind"];
  readonly layerId: string;
}

export interface PaintStrokeState {
  readonly stroke: Stroke | null;
}

const empty: PaintStrokeState = { stroke: null };

export interface PaintStrokeConfig {
  readonly id: string;
  /** True only for the eraser — the one tool whose stroke removes pixels
   * instead of laying colour into them, and only when painting the layer
   * itself: erasing a mask paints white instead (see `resolveColor`), since
   * a mask pixel is a threshold, not an alpha channel to punch a hole in. */
  readonly erase: boolean;
  /** True only for the pencil: a hard 1px edge regardless of the
   * `hardness` option, which the pencil's own `tools.ts` entry does not
   * even expose. */
  readonly pinnedHardness: boolean;
  /** What a full stroke's history entry reads, when painting the layer
   * itself. Painting a mask always reads "Paint Layer Mask" instead,
   * regardless of which of the four tools did it — matching the label the
   * old switch used for every one of them. */
  readonly label: string;
}

function strokeKey(target: PaintTarget): string {
  return target.kind === "mask" ? `mask:${target.layerId}` : target.layerId;
}

function resolveColor(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig) {
  if (config.erase && context.paintTarget.kind === "mask") return parseHexColor("#ffffff");
  return parseHexColor(context.paintColor);
}

function resolvedOptions(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig) {
  const options = context.options;
  return {
    size: Number(options.size ?? 24),
    opacity: Number(options.opacity ?? 100) / 100 * Number(options.flow ?? 100) / 100,
    hardness: config.pinnedHardness ? 1 : Number(options.hardness ?? 82) / 100,
    spacing: Number(options.spacing ?? 12) / 100,
    roundness: Number(options.roundness ?? 100) / 100,
    angle: Number(options.angle ?? 0),
    pressureSize: options.pressureSize !== false,
    pressureOpacity: options.pressureOpacity === true,
  };
}

function paintDab(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig, target: Uint8ClampedArray, point: Point): void {
  const o = resolvedOptions(context, config);
  const erase = config.erase && context.paintTarget.kind === "pixels";
  drawDab(target, context.document.width, context.document.height, point, o.size, resolveColor(context, config), o.opacity, erase, o.hardness, context.paintMask, o.roundness, o.angle, o.pressureSize, o.pressureOpacity);
}

function paintSegment(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig, target: Uint8ClampedArray, from: Point, control: Point, to: Point): void {
  const o = resolvedOptions(context, config);
  const erase = config.erase && context.paintTarget.kind === "pixels";
  drawQuadraticStrokeSegment(target, context.document.width, context.document.height, from, control, to, o.size, resolveColor(context, config), o.opacity, erase, context.paintMask, o.hardness, o.spacing, o.roundness, o.angle, o.pressureSize, o.pressureOpacity);
}

/** Extends the stroke to `point`, mutating it in place — see the note on the
 * interface above for why this does not go through `setState`. */
function appendPoint(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig, stroke: Stroke, point: Point): void {
  if (Math.hypot(point.x - stroke.pending.x, point.y - stroke.pending.y) < 0.05) return;
  const end: Point = { x: (stroke.pending.x + point.x) / 2, y: (stroke.pending.y + point.y) / 2, pressure: ((stroke.pending.pressure ?? 1) + (point.pressure ?? 1)) / 2 };
  paintSegment(context, config, stroke.working, stroke.curveStart, stroke.pending, end);
  const pad = Number(context.options.size ?? 24) / 2 + 2;
  stroke.dirty = unionRect(stroke.dirty, stroke.curveStart.x, stroke.curveStart.y, stroke.pending.x, stroke.pending.y, pad);
  stroke.dirty = unionRect(stroke.dirty, point.x, point.y, end.x, end.y, pad);
  stroke.strokeBounds = unionRect(stroke.strokeBounds, stroke.dirty.x, stroke.dirty.y, stroke.dirty.x + stroke.dirty.width, stroke.dirty.y + stroke.dirty.height, 0);
  stroke.curveStart = end;
  stroke.pending = point;
}

function commitStroke(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig, stroke: Stroke): void {
  const label = stroke.target === "mask" ? "Paint Layer Mask (Рисование по маске слоя)" : config.label;
  void context.commit(stroke.before, stroke.working, label, stroke.target, stroke.layerId, stroke.strokeBounds);
}

export function createPaintStrokeTool(config: PaintStrokeConfig): RasterToolDefinition<PaintStrokeState> {
  return {
    id: config.id,
    requiresRasterized: true,
    createState: () => empty,

    onPointerDown(context, pointer) {
      // Alt samples a colour (or, on a mask, which side of black/white the
      // pixel is already on) instead of painting — the one modifier every
      // brush-family tool reads before anything else, and read before the
      // lock check below because sampling is not an edit.
      if (pointer.altKey) {
        const width = context.document.width, height = context.document.height;
        if (context.paintTarget.kind === "mask") {
          const rgba = context.targetPixels();
          const index = Math.max(0, Math.min(width * height - 1, Math.floor(pointer.point.y) * width + Math.floor(pointer.point.x)));
          context.setMaskForegroundWhite((rgba[index * 4] ?? 0) >= 128);
        } else {
          context.setForegroundColor(toHexColor(sampleAverage(context.compositePixels(), width, height, pointer.point.x, pointer.point.y, 1)));
        }
        return;
      }
      if (locksRefuse(context, config.erase ? "erase" : "paint", config.id)) return;
      context.capturePointer(pointer.pointerId);

      const key = strokeKey(context.paintTarget);
      const last = context.lastStrokePoint;
      const shiftFrom = pointer.shiftKey && last?.toolId === config.id && last.layerId === key ? last.point : null;
      const before = context.targetPixels();
      const working = before.slice();

      if (shiftFrom) {
        // A click-then-Shift-click line is a single instant edit, not a
        // gesture in progress — same as in the old switch, which never
        // touched `gesture.current` for this case either.
        const control: Point = { x: (shiftFrom.x + pointer.point.x) / 2, y: (shiftFrom.y + pointer.point.y) / 2, pressure: 1 };
        paintSegment(context, config, working, shiftFrom, control, pointer.point);
        context.setLastStrokePoint({ toolId: config.id, layerId: key, point: pointer.point });
        context.schedulePreview(working, context.paintTarget.kind, context.paintTarget.layerId, null);
        void context.commit(before, working, context.paintTarget.kind === "mask" ? "Paint Layer Mask (Рисование по маске слоя)" : "Straight Brush Line (Прямая линия кисти)", context.paintTarget.kind, context.paintTarget.layerId);
        return;
      }

      paintDab(context, config, working, pointer.point);
      context.schedulePreview(working, context.paintTarget.kind, context.paintTarget.layerId, null);
      context.setState({
        stroke: { pointerId: pointer.pointerId, before, working, curveStart: pointer.point, pending: pointer.point, dirty: null, strokeBounds: null, target: context.paintTarget.kind, layerId: context.paintTarget.layerId },
      });
    },

    onPointerMove(context, pointer) {
      const stroke = context.state.stroke;
      if (!stroke || stroke.pointerId !== pointer.pointerId) return;
      appendPoint(context, config, stroke, pointer.point);
      context.schedulePreview(stroke.working, stroke.target, stroke.layerId, stroke.dirty);
      stroke.dirty = null;
    },

    onGestureEnd(context, pointer) {
      const stroke = context.state.stroke;
      if (!stroke || stroke.pointerId !== pointer.pointerId) return;
      appendPoint(context, config, stroke, pointer.point);
      // The curve lags half a step behind the raw input by construction
      // (`appendPoint` always ends on a midpoint) — this closes the last
      // gap so the stroke visibly reaches where the pointer was released.
      paintSegment(context, config, stroke.working, stroke.curveStart, stroke.pending, stroke.pending);
      context.setLastStrokePoint({ toolId: config.id, layerId: strokeKey({ kind: stroke.target, layerId: stroke.layerId }), point: stroke.pending });
      commitStroke(context, config, stroke);
      context.setState(empty);
    },

    onDeactivate(context) {
      // Switching tool mid-drag commits what was painted so far rather than
      // discarding it or leaving the buffer stranded in this tool's state,
      // which the old imperative code — mid-gesture tool switches were
      // never handled cleanly there — did not need an answer for. This one
      // is the tool's own, made because keeping the stroke beats losing it.
      const stroke = context.state.stroke;
      if (!stroke) return;
      commitStroke(context, config, stroke);
      context.setState(empty);
    },
  };
}
