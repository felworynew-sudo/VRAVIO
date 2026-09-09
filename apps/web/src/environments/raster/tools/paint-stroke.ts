import { accumulateDab, accumulateStrokeSegment, compositeCoverage, parseHexColor, sampleAverage, toHexColor, unionRect, type Point, type RasterRect } from "@vravio/env-raster";
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
  /** Distance travelled since the last dab, carried across pointer samples — without it every
   * sample would get a dab of its own regardless of the brush's spacing. See
   * `accumulateStrokeSegment`, which owns the explanation. */
  spacingCarry: number;
  /**
   * How much of the stroke has reached each pixel, 0..255.
   *
   * The dabs go here, and the picture is composited from `before` plus this, once per frame over
   * the band that changed. Compositing each dab straight into the layer instead blended the same
   * pixel about eight times at the default spacing — measured, four times the cost of a stroke at
   * 50% spacing — and made a half-opacity stroke darken wherever it crossed itself, which
   * Photoshop's does not.
   */
  coverage: Uint8ClampedArray;
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
    // Two separate numbers, as in Photoshop: opacity is the most the stroke may ever reach, flow
    // is how fast each dab gets there. Multiplied together, as they used to be, neither can mean
    // what it says — a 50% stroke would keep darkening every time it crossed itself.
    opacity: Number(options.opacity ?? 100) / 100,
    flow: Number(options.flow ?? 100) / 100,
    hardness: config.pinnedHardness ? 1 : Number(options.hardness ?? 82) / 100,
    spacing: Number(options.spacing ?? 12) / 100,
    roundness: Number(options.roundness ?? 100) / 100,
    angle: Number(options.angle ?? 0),
    pressureSize: options.pressureSize !== false,
    pressureOpacity: options.pressureOpacity === true,
  };
}

function paintDab(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig, coverage: Uint8ClampedArray, point: Point): void {
  const o = resolvedOptions(context, config);
  accumulateDab(coverage, context.document.width, context.document.height, point, o.size, o.flow, o.opacity, o.hardness, context.paintMask, o.roundness, o.angle, o.pressureSize, o.pressureOpacity);
}

function paintSegment(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig, coverage: Uint8ClampedArray, from: Point, control: Point, to: Point, carry = 0): number {
  const o = resolvedOptions(context, config);
  return accumulateStrokeSegment(coverage, context.document.width, context.document.height, from, control, to, o.size, o.flow, o.opacity, context.paintMask, o.hardness, o.spacing, o.roundness, o.angle, o.pressureSize, o.pressureOpacity, carry);
}

/** Lays the coverage gathered so far onto the working buffer, over one rectangle. */
function layStroke(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig, stroke: Stroke, region: RasterRect): void {
  const erase = config.erase && context.paintTarget.kind === "pixels";
  compositeCoverage(stroke.working, stroke.before, stroke.coverage, context.document.width, context.document.height, region, resolveColor(context, config), erase);
}

/** Extends the stroke to `point`, mutating it in place — see the note on the
 * interface above for why this does not go through `setState`. */
function appendPoint(context: ToolContext<PaintStrokeState>, config: PaintStrokeConfig, stroke: Stroke, point: Point): void {
  if (Math.hypot(point.x - stroke.pending.x, point.y - stroke.pending.y) < 0.05) return;
  const end: Point = { x: (stroke.pending.x + point.x) / 2, y: (stroke.pending.y + point.y) / 2, pressure: ((stroke.pending.pressure ?? 1) + (point.pressure ?? 1)) / 2 };
  stroke.spacingCarry = paintSegment(context, config, stroke.coverage, stroke.curveStart, stroke.pending, end, stroke.spacingCarry);
  const pad = Number(context.options.size ?? 24) / 2 + 2;
  const touched = unionRect(
    unionRect(null, stroke.curveStart.x, stroke.curveStart.y, stroke.pending.x, stroke.pending.y, pad),
    point.x, point.y, end.x, end.y, pad,
  );
  // Laid down once for the band this step touched, from the pristine `before` — so a band that
  // gets recomposited on a later frame does not build on itself.
  layStroke(context, config, stroke, touched);
  stroke.dirty = stroke.dirty ? unionRect(stroke.dirty, touched.x, touched.y, touched.x + touched.width, touched.y + touched.height, 0) : touched;
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
        const lineCoverage = new Uint8ClampedArray(context.document.width * context.document.height);
        paintSegment(context, config, lineCoverage, shiftFrom, control, pointer.point);
        const pad = Number(context.options.size ?? 24) / 2 + 2;
        const line = unionRect(null, shiftFrom.x, shiftFrom.y, pointer.point.x, pointer.point.y, pad);
        layStroke(context, config, { before, working, coverage: lineCoverage } as Stroke, line);
        context.setLastStrokePoint({ toolId: config.id, layerId: key, point: pointer.point });
        context.schedulePreview(working, context.paintTarget.kind, context.paintTarget.layerId, null);
        void context.commit(before, working, context.paintTarget.kind === "mask" ? "Paint Layer Mask (Рисование по маске слоя)" : "Straight Brush Line (Прямая линия кисти)", context.paintTarget.kind, context.paintTarget.layerId);
        return;
      }

      const coverage = new Uint8ClampedArray(context.document.width * context.document.height);
      const stroke: Stroke = { pointerId: pointer.pointerId, before, working, coverage, curveStart: pointer.point, pending: pointer.point, dirty: null, strokeBounds: null, spacingCarry: 0, target: context.paintTarget.kind, layerId: context.paintTarget.layerId };
      paintDab(context, config, coverage, pointer.point);
      const pad = Number(context.options.size ?? 24) / 2 + 2;
      const first = unionRect(null, pointer.point.x, pointer.point.y, pointer.point.x, pointer.point.y, pad);
      layStroke(context, config, stroke, first);
      stroke.strokeBounds = first;
      context.schedulePreview(working, context.paintTarget.kind, context.paintTarget.layerId, first);
      context.setState({ stroke });
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
      paintSegment(context, config, stroke.coverage, stroke.curveStart, stroke.pending, stroke.pending, stroke.spacingCarry);
      const closing = unionRect(null, stroke.curveStart.x, stroke.curveStart.y, stroke.pending.x, stroke.pending.y, Number(context.options.size ?? 24) / 2 + 2);
      layStroke(context, config, stroke, closing);
      stroke.strokeBounds = unionRect(stroke.strokeBounds, closing.x, closing.y, closing.x + closing.width, closing.y + closing.height, 0);
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
