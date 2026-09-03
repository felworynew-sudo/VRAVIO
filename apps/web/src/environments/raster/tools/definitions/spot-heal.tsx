import { copyHealedRegion, spotHealApply, spotHealDab, spotHealStrokeSegment } from "@vravio/env-raster";
import type { RasterToolDefinition, ToolContext } from "../types";

/**
 * Spot healing: drag marks a region, and only on release is it actually
 * repaired — one Poisson solve over the whole marked area at once, not one
 * per dab, which is what keeps overlapping dabs from seaming.
 *
 * Never touches a mask, same reason as clone and the tonal tools. The
 * accumulating mask is a plain rectangle grown on demand as the drag
 * strays outside it — ported byte-for-byte from the old `handlePointerMove`
 * branch, not simplified, because the growth math is what keeps the mask
 * exactly as large as the strokes that have touched it and no larger.
 */

interface Stroke {
  readonly pointerId: number;
  readonly before: Uint8ClampedArray;
  mask: Uint8ClampedArray;
  originX: number;
  originY: number;
  width: number;
  height: number;
}

interface SpotHealState {
  readonly stroke: Stroke | null;
}

const empty: SpotHealState = { stroke: null };

/**
 * Intersects a healing mask (the brush's own accumulated stroke shape) with
 * the selection/lock-transparency restriction every painting tool is
 * confined to.
 *
 * None of `spotHealDab`/`spotHealApply`/`copyHealedRegion` take a selection
 * mask of their own — a healing mask already *is* a region-of-effect the
 * same shape a selection mask is, so folding the restriction into it here
 * confines the repair without needing a second mask parameter threaded
 * through every one of those primitives.
 */
function confineHealMask(context: ToolContext<SpotHealState>, mask: Uint8ClampedArray, originX: number, originY: number, width: number, height: number): Uint8ClampedArray {
  const restriction = context.paintMask;
  if (!restriction) return mask;
  const docWidth = context.document.width, docHeight = context.document.height;
  const confined = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y += 1) {
    const canvasY = originY + y;
    if (canvasY < 0 || canvasY >= docHeight) continue;
    for (let x = 0; x < width; x += 1) {
      const canvasX = originX + x;
      if (canvasX < 0 || canvasX >= docWidth) continue;
      const index = y * width + x;
      confined[index] = Math.min(mask[index]!, restriction[canvasY * docWidth + canvasX]!);
    }
  }
  return confined;
}

function healedResult(context: ToolContext<SpotHealState>, stroke: Stroke): Uint8ClampedArray {
  const options = context.options;
  const opacity = Number(options.opacity ?? 100) / 100;
  const working = stroke.before.slice();
  const mask = confineHealMask(context, stroke.mask, stroke.originX, stroke.originY, stroke.width, stroke.height);
  if (options.sampleAllLayers === true) {
    // Computed on the composite, written back only where the mask covers:
    // the repair belongs to this layer, the rest of the picture does not.
    const healed = context.compositePixels();
    spotHealApply(healed, context.document.width, context.document.height, mask, stroke.originX, stroke.originY, stroke.width, stroke.height, opacity);
    copyHealedRegion(working, healed, mask, stroke.originX, stroke.originY, stroke.width, stroke.height, context.document.width, context.document.height);
  } else {
    spotHealApply(working, context.document.width, context.document.height, mask, stroke.originX, stroke.originY, stroke.width, stroke.height, opacity);
  }
  return working;
}

function commitHeal(context: ToolContext<SpotHealState>, stroke: Stroke): void {
  void context.commit(stroke.before, healedResult(context, stroke), "Spot Healing (Точечное восстановление)", "pixels", context.paintTarget.layerId);
}

const spotHeal: RasterToolDefinition<SpotHealState> = {
  id: "raster.spotHeal",
  requiresRasterized: true,
  createState: () => empty,

  onPointerDown(context, pointer) {
    if (context.paintTarget.kind === "mask") return;
    if (context.activeLayer?.locked) return;
    context.capturePointer(pointer.pointerId);
    const before = context.layerPixels();
    const options = context.options;
    const size = Number(options.size ?? 24);
    const radius = Math.ceil(size / 2) + 8;
    const hardness = Number(options.hardness ?? 82) / 100, roundness = Number(options.roundness ?? 100) / 100, angle = Number(options.angle ?? 0), spacing = Number(options.spacing ?? 12) / 100;
    const key = context.paintTarget.layerId;
    const last = context.lastStrokePoint;
    const shiftFrom = pointer.shiftKey && last?.toolId === spotHeal.id && last.layerId === key ? last.point : null;

    if (shiftFrom) {
      const lineOriginX = Math.max(0, Math.floor(Math.min(shiftFrom.x, pointer.point.x)) - radius);
      const lineOriginY = Math.max(0, Math.floor(Math.min(shiftFrom.y, pointer.point.y)) - radius);
      const lineRight = Math.min(context.document.width, Math.ceil(Math.max(shiftFrom.x, pointer.point.x)) + radius);
      const lineBottom = Math.min(context.document.height, Math.ceil(Math.max(shiftFrom.y, pointer.point.y)) + radius);
      const lineWidth = lineRight - lineOriginX, lineHeight = lineBottom - lineOriginY;
      const lineMask = new Uint8ClampedArray(lineWidth * lineHeight);
      spotHealStrokeSegment(lineMask, lineOriginX, lineOriginY, lineWidth, lineHeight, shiftFrom.x, shiftFrom.y, pointer.point.x, pointer.point.y, size, hardness, roundness, angle, spacing);
      const working = healedResult(context, { pointerId: pointer.pointerId, before, mask: lineMask, originX: lineOriginX, originY: lineOriginY, width: lineWidth, height: lineHeight });
      context.setLastStrokePoint({ toolId: spotHeal.id, layerId: key, point: pointer.point });
      context.schedulePreview(working, "pixels", key, null);
      void context.commit(before, working, "Spot Healing Line (Линия восстановления)");
      return;
    }

    const originX = Math.max(0, Math.floor(pointer.point.x) - radius);
    const originY = Math.max(0, Math.floor(pointer.point.y) - radius);
    const originX2 = Math.min(context.document.width, Math.ceil(pointer.point.x) + radius);
    const originY2 = Math.min(context.document.height, Math.ceil(pointer.point.y) + radius);
    const width = originX2 - originX, height = originY2 - originY;
    const mask = new Uint8ClampedArray(width * height);
    spotHealDab(mask, originX, originY, width, height, pointer.point.x, pointer.point.y, size, hardness, roundness, angle);
    context.setState({ stroke: { pointerId: pointer.pointerId, before, mask, originX, originY, width, height } });
    context.previewSpotHealMask(mask, originX, originY, width, height);
  },

  onPointerMove(context, pointer) {
    const stroke = context.state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    const options = context.options;
    const size = Number(options.size ?? 24);
    const radius = Math.ceil(size / 2) + 8;
    const newLeft = Math.max(0, Math.floor(pointer.point.x) - radius);
    const newTop = Math.max(0, Math.floor(pointer.point.y) - radius);
    const newRight = Math.min(context.document.width, Math.ceil(pointer.point.x) + radius);
    const newBottom = Math.min(context.document.height, Math.ceil(pointer.point.y) + radius);
    if (newLeft < stroke.originX || newTop < stroke.originY || newRight > stroke.originX + stroke.width || newBottom > stroke.originY + stroke.height) {
      const expandedOriginX = Math.min(stroke.originX, newLeft);
      const expandedOriginY = Math.min(stroke.originY, newTop);
      const expandedW = Math.max(stroke.originX + stroke.width, newRight) - expandedOriginX;
      const expandedH = Math.max(stroke.originY + stroke.height, newBottom) - expandedOriginY;
      const expanded = new Uint8ClampedArray(expandedW * expandedH);
      for (let y = 0; y < stroke.height; y += 1) for (let x = 0; x < stroke.width; x += 1) {
        const m = stroke.mask[y * stroke.width + x]!;
        if (m > 0) expanded[(y + stroke.originY - expandedOriginY) * expandedW + (x + stroke.originX - expandedOriginX)] = m;
      }
      stroke.mask = expanded; stroke.originX = expandedOriginX; stroke.originY = expandedOriginY; stroke.width = expandedW; stroke.height = expandedH;
    }
    spotHealDab(stroke.mask, stroke.originX, stroke.originY, stroke.width, stroke.height, pointer.point.x, pointer.point.y, size, Number(options.hardness ?? 82) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
    context.previewSpotHealMask(stroke.mask, stroke.originX, stroke.originY, stroke.width, stroke.height);
  },

  onGestureEnd(context, pointer) {
    const stroke = context.state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    context.setLastStrokePoint({ toolId: spotHeal.id, layerId: context.paintTarget.layerId, point: pointer.point });
    commitHeal(context, stroke);
    context.setState(empty);
  },

  onDeactivate(context) {
    const stroke = context.state.stroke;
    if (!stroke) return;
    commitHeal(context, stroke);
    context.setState(empty);
  },
};

export default spotHeal;
