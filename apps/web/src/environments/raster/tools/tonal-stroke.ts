import { blurDab, blurStrokeSegment, dodgeBurnDab, dodgeBurnStrokeSegment, sampleAverage, smudgeStrokeSegment, toHexColor, unionRect, type DodgeBurnRange, type Point, type RasterRect } from "@vravio/env-raster";
import type { RasterToolDefinition, ToolContext, ToolPointer } from "./types";

/**
 * The dragged-stroke shape blur, smudge, dodge and burn share.
 *
 * The other half of the seven-tool pipeline `paint-stroke.ts` split off —
 * see its own note for why the two halves were never one factory: these
 * four read and distort pixels already on the layer instead of laying new
 * colour into it, never touch a mask (there is nothing tonal to adjust in a
 * black-and-white threshold buffer), and use a straight segment from the
 * curve's start to the raw incoming point rather than paint-stroke's
 * midpoint-smoothed quadratic curve — a difference `appendPoint` below
 * carries forward from the old `appendBrushPoint`, not one invented here.
 * Blur and smudge additionally read from the gesture's original, untouched
 * snapshot (`stroke.before`) rather than the accumulating `working` buffer,
 * so each dab blends fresh from the source instead of blurring what an
 * earlier dab in the same stroke already blurred.
 */

interface Stroke {
  readonly pointerId: number;
  readonly before: Uint8ClampedArray;
  working: Uint8ClampedArray;
  curveStart: Point;
  pending: Point;
  dirty: RasterRect | null;
  strokeBounds: RasterRect | null;
}

export interface TonalStrokeState {
  readonly stroke: Stroke | null;
}

const empty: TonalStrokeState = { stroke: null };

export interface TonalStrokeConfig {
  readonly id: string;
  readonly kind: "blur" | "smudge" | "dodge" | "burn";
  readonly label: string;
}

function resolvedOptions(context: ToolContext<TonalStrokeState>) {
  const options = context.options;
  return {
    size: Number(options.size ?? 24),
    strength: Number(options.strength ?? 50) / 100,
    exposure: Number(options.exposure ?? 50) / 100,
    range: (options.range as DodgeBurnRange) ?? "midtones",
    roundness: Number(options.roundness ?? 100) / 100,
    angle: Number(options.angle ?? 0),
    hardness: Number(options.hardness ?? 82) / 100,
    spacing: Number(options.spacing ?? 12) / 100,
  };
}

/** The one-shot dab a press paints before any drag exists. Smudge has none
 * — Photoshop's smudge tool has nothing to smear until the pointer moves,
 * exactly as the old switch left it. */
function paintDab(context: ToolContext<TonalStrokeState>, config: TonalStrokeConfig, working: Uint8ClampedArray, before: Uint8ClampedArray, point: Point): void {
  const o = resolvedOptions(context);
  const w = context.document.width, h = context.document.height;
  if (config.kind === "blur") blurDab(working, before, w, h, point, o.size, o.strength, context.paintMask, o.roundness, o.angle, o.hardness);
  else if (config.kind === "dodge" || config.kind === "burn") dodgeBurnDab(working, w, h, point, o.size, o.exposure, config.kind, o.range, context.paintMask, o.roundness, o.angle, o.hardness);
}

function paintSegment(context: ToolContext<TonalStrokeState>, config: TonalStrokeConfig, working: Uint8ClampedArray, before: Uint8ClampedArray, from: Point, to: Point): void {
  const o = resolvedOptions(context);
  const w = context.document.width, h = context.document.height;
  if (config.kind === "blur") blurStrokeSegment(working, before, w, h, from, to, o.size, o.strength, context.paintMask, o.roundness, o.angle, o.hardness);
  else if (config.kind === "smudge") smudgeStrokeSegment(working, before, w, h, from, to, o.size, o.strength, context.paintMask, o.roundness, o.angle, o.hardness, o.spacing);
  else dodgeBurnStrokeSegment(working, w, h, from, to, o.size, o.exposure, config.kind, o.range, context.paintMask, o.roundness, o.angle, o.hardness, o.spacing);
}

/** Extends the stroke to `point`, mutating it in place — see paint-stroke.ts's
 * note on why this does not go through `setState`. */
function appendPoint(context: ToolContext<TonalStrokeState>, config: TonalStrokeConfig, stroke: Stroke, point: Point): void {
  if (Math.hypot(point.x - stroke.pending.x, point.y - stroke.pending.y) < 0.05) return;
  const end: Point = { x: (stroke.pending.x + point.x) / 2, y: (stroke.pending.y + point.y) / 2, pressure: ((stroke.pending.pressure ?? 1) + (point.pressure ?? 1)) / 2 };
  // Unlike paint-stroke's segment, this draws to the raw `point`, not the
  // smoothed `end` — the old `appendBrushPoint` never smoothed these four.
  paintSegment(context, config, stroke.working, stroke.before, stroke.curveStart, point);
  const pad = Number(context.options.size ?? 24) / 2 + 2;
  stroke.dirty = unionRect(stroke.dirty, stroke.curveStart.x, stroke.curveStart.y, stroke.pending.x, stroke.pending.y, pad);
  stroke.dirty = unionRect(stroke.dirty, point.x, point.y, end.x, end.y, pad);
  stroke.strokeBounds = unionRect(stroke.strokeBounds, stroke.dirty.x, stroke.dirty.y, stroke.dirty.x + stroke.dirty.width, stroke.dirty.y + stroke.dirty.height, 0);
  stroke.curveStart = end;
  stroke.pending = point;
}

function commitStroke(context: ToolContext<TonalStrokeState>, config: TonalStrokeConfig, stroke: Stroke): void {
  void context.commit(stroke.before, stroke.working, config.label, "pixels", context.paintTarget.layerId, stroke.strokeBounds);
}

export function createTonalStrokeTool(config: TonalStrokeConfig): RasterToolDefinition<TonalStrokeState> {
  return {
    id: config.id,
    requiresRasterized: true,
    createState: () => empty,

    onPointerDown(context, pointer) {
      // Alt samples a colour (or, on a mask, which side of black/white a
      // pixel already sits on) instead of painting — read before the lock
      // and mask checks below, exactly as the old switch had it, and before
      // capturing the pointer since sampling never starts a gesture.
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
      if (context.activeLayer?.locked) return;
      // Nothing tonal to adjust in a mask's black-and-white threshold.
      if (context.paintTarget.kind === "mask") return;
      context.capturePointer(pointer.pointerId);

      const key = context.paintTarget.layerId;
      const last = context.lastStrokePoint;
      const shiftFrom = pointer.shiftKey && last?.toolId === config.id && last.layerId === key ? last.point : null;
      const before = context.targetPixels();
      const working = before.slice();

      if (shiftFrom) {
        paintSegment(context, config, working, before, shiftFrom, pointer.point);
        context.setLastStrokePoint({ toolId: config.id, layerId: key, point: pointer.point });
        context.schedulePreview(working, "pixels", context.paintTarget.layerId, null);
        void context.commit(before, working, "Straight Brush Line (Прямая линия кисти)", "pixels", context.paintTarget.layerId);
        return;
      }

      paintDab(context, config, working, before, pointer.point);
      context.schedulePreview(working, "pixels", context.paintTarget.layerId, null);
      context.setState({
        stroke: { pointerId: pointer.pointerId, before, working, curveStart: pointer.point, pending: pointer.point, dirty: null, strokeBounds: null },
      });
    },

    onPointerMove(context, pointer) {
      const stroke = context.state.stroke;
      if (!stroke || stroke.pointerId !== pointer.pointerId) return;
      appendPoint(context, config, stroke, pointer.point);
      context.schedulePreview(stroke.working, "pixels", context.paintTarget.layerId, stroke.dirty);
      stroke.dirty = null;
    },

    onGestureEnd(context, pointer) {
      const stroke = context.state.stroke;
      if (!stroke || stroke.pointerId !== pointer.pointerId) return;
      appendPoint(context, config, stroke, pointer.point);
      // Unlike paint-stroke's brush family, nothing closes the last gap here
      // — the old code never did either; these four have no equivalent
      // final dab at gesture end.
      context.setLastStrokePoint({ toolId: config.id, layerId: context.paintTarget.layerId, point: stroke.pending });
      commitStroke(context, config, stroke);
      context.setState(empty);
    },

    onDeactivate(context) {
      // Same choice paint-stroke.ts made: commit an in-progress stroke on a
      // mid-drag tool switch rather than strand or corrupt it.
      const stroke = context.state.stroke;
      if (!stroke) return;
      commitStroke(context, config, stroke);
      context.setState(empty);
    },
  };
}
