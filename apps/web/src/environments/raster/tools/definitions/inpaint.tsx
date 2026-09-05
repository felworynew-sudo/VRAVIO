import { spotHealDab } from "@vravio/env-raster";
import { beginBusy } from "../../../../busy";
import { diagnostic } from "../../../../diagnostics";
import { errorModal } from "../../../../modals/runtime";
import { defaultInpaintModelId, inpaintModelById } from "../../../../ml/inpaint/registry";
import { runInpaint } from "../../../../ml/inpaint/run";
import type { RasterToolDefinition, ToolContext } from "../types";
import { locksRefuse } from "../lock-guard";

/**
 * The removing brush: paint over something, let go, and it is gone.
 *
 * The gesture is `raster.spotHeal`'s, deliberately — drag accumulates a mask,
 * the marked area is tinted while you drag, and the repair happens once on
 * release rather than per dab, because overlapping repairs seam. What differs
 * is the repair itself: instead of a Poisson solve over the surroundings, the
 * marked region goes to an inpainting model, which invents plausible content
 * rather than smearing neighbouring pixels into the hole.
 *
 * Which model is a tool option, so the choice is where the brush is rather
 * than in a settings page: MI-GAN is 29 MB and quick, LaMa is 208 MB and
 * markedly better on anything large. See `ml/inpaint/definitions/`.
 *
 * The repair is asynchronous — a model takes seconds — where every other
 * painting tool commits synchronously. That is why the gesture ends by
 * *starting* the work and clearing its own state: holding the stroke open
 * until a model answered would leave the brush unusable meanwhile, and
 * leaving the tinted mask on screen would suggest the mark was still editable.
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

interface InpaintState { readonly stroke: Stroke | null }

const empty: InpaintState = { stroke: null };

const radiusFor = (context: ToolContext<InpaintState>): number => Math.ceil(Number(context.options.size ?? 48) / 2) + 8;

/**
 * The stroke's region-local mask, laid out over the whole canvas and confined
 * to whatever the user may paint.
 *
 * `runInpaint` works in canvas coordinates because the region it chooses has
 * to be a window onto the layer, not onto the stroke's own bounding box. The
 * confinement is the same one every painting tool honours — a selection means
 * a selection here too.
 */
function canvasMask(context: ToolContext<InpaintState>, stroke: Stroke): Uint8ClampedArray {
  const width = context.document.width, height = context.document.height;
  const restriction = context.paintMask;
  const mask = new Uint8ClampedArray(width * height);
  for (let y = 0; y < stroke.height; y += 1) {
    const canvasY = stroke.originY + y;
    if (canvasY < 0 || canvasY >= height) continue;
    for (let x = 0; x < stroke.width; x += 1) {
      const canvasX = stroke.originX + x;
      if (canvasX < 0 || canvasX >= width) continue;
      const value = stroke.mask[y * stroke.width + x]!;
      if (!value) continue;
      const at = canvasY * width + canvasX;
      mask[at] = restriction ? Math.min(value, restriction[at]!) : value;
    }
  }
  return mask;
}

function fill(context: ToolContext<InpaintState>, stroke: Stroke): void {
  const model = inpaintModelById(String(context.options.model ?? defaultInpaintModelId));
  if (!model) { diagnostic("warn", "ml.inpaint", `No inpainting model called "${context.options.model}"`); return; }

  const mask = canvasMask(context, stroke);
  const { width, height } = context.document;
  const layerId = context.paintTarget.layerId;
  const before = stroke.before;

  void (async () => {
    const done = beginBusy("Filling (Заполнение)");
    try {
      const outcome = await runInpaint(model, before, width, height, mask);
      if (outcome.error) {
        errorModal({
          title: "Inpainting failed (Не удалось заполнить)",
          message: `${model.id}: ${outcome.error}`,
        });
        return;
      }
      // No pixels and no error is a gesture that marked nothing, or one the
      // user cancelled — neither is worth a history step.
      if (outcome.pixels) void context.commit(before, outcome.pixels, "Remove (Удаление объекта)", "pixels", layerId);
    } finally { done(); }
  })();
}

const inpaint: RasterToolDefinition<InpaintState> = {
  id: "raster.inpaint",
  requiresRasterized: true,
  createState: () => empty,

  onPointerDown(context, pointer) {
    if (context.paintTarget.kind === "mask") return;
    if (locksRefuse(context, "paint", "raster.inpaint")) return;
    context.capturePointer(pointer.pointerId);

    const radius = radiusFor(context);
    const originX = Math.max(0, Math.floor(pointer.point.x) - radius);
    const originY = Math.max(0, Math.floor(pointer.point.y) - radius);
    const width = Math.min(context.document.width, Math.ceil(pointer.point.x) + radius) - originX;
    const height = Math.min(context.document.height, Math.ceil(pointer.point.y) + radius) - originY;
    const mask = new Uint8ClampedArray(Math.max(0, width) * Math.max(0, height));
    spotHealDab(mask, originX, originY, width, height, pointer.point.x, pointer.point.y, Number(context.options.size ?? 48), 1, 1, 0);

    context.setState({ stroke: { pointerId: pointer.pointerId, before: context.layerPixels(), mask, originX, originY, width, height } });
    context.previewSpotHealMask(mask, originX, originY, width, height);
  },

  onPointerMove(context, pointer) {
    const stroke = context.state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    const radius = radiusFor(context);
    const left = Math.max(0, Math.floor(pointer.point.x) - radius);
    const top = Math.max(0, Math.floor(pointer.point.y) - radius);
    const right = Math.min(context.document.width, Math.ceil(pointer.point.x) + radius);
    const bottom = Math.min(context.document.height, Math.ceil(pointer.point.y) + radius);

    // The mask grows to cover wherever the drag has gone, and no further —
    // the same growth `spotHeal` does, for the same reason: a canvas-sized
    // mask per stroke would be megabytes for a mark the size of a coin.
    if (left < stroke.originX || top < stroke.originY || right > stroke.originX + stroke.width || bottom > stroke.originY + stroke.height) {
      const originX = Math.min(stroke.originX, left), originY = Math.min(stroke.originY, top);
      const width = Math.max(stroke.originX + stroke.width, right) - originX;
      const height = Math.max(stroke.originY + stroke.height, bottom) - originY;
      const grown = new Uint8ClampedArray(width * height);
      for (let y = 0; y < stroke.height; y += 1) for (let x = 0; x < stroke.width; x += 1) {
        const value = stroke.mask[y * stroke.width + x]!;
        if (value) grown[(y + stroke.originY - originY) * width + (x + stroke.originX - originX)] = value;
      }
      stroke.mask = grown; stroke.originX = originX; stroke.originY = originY; stroke.width = width; stroke.height = height;
    }

    // Hard-edged: a mask is a decision about which pixels are gone, and a
    // feathered edge would ask the model to half-remove a pixel.
    spotHealDab(stroke.mask, stroke.originX, stroke.originY, stroke.width, stroke.height, pointer.point.x, pointer.point.y, Number(context.options.size ?? 48), 1, 1, 0);
    context.previewSpotHealMask(stroke.mask, stroke.originX, stroke.originY, stroke.width, stroke.height);
  },

  onGestureEnd(context) {
    const stroke = context.state.stroke;
    if (!stroke) return;
    context.setState(empty);
    fill(context, stroke);
  },

  onDeactivate(context) {
    // Switching tool mid-mark throws the mark away rather than filling it:
    // unlike a brush stroke, which is already visible and worth keeping, a
    // half-drawn mark is a question that was never asked.
    if (context.state.stroke) context.setState(empty);
  },
};

export default inpaint;
