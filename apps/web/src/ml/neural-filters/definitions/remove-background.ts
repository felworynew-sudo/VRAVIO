import { kernel } from "../../../kernel";
import { runSegmentation } from "../../segment/run";
import { defaultSegmentModelId, segmentModelById } from "../../segment/registry";
import type { NeuralFilterDefinition } from "../types";

/**
 * Remove Background as a Neural Filters entry — the same U²-Net-P model and `runSegmentation`
 * call `RasterPixelLayerProperties.tsx`'s own Quick Action already uses (docs/master-plan.md
 * §40), through this panel's own door instead. Not a duplicate feature so much as a second,
 * equally legitimate entry point to one — Photoshop itself repeats "Select Subject" the same way
 * (its own Select menu and the Properties panel's Quick Actions both reach it).
 *
 * Fits this panel's "same size in, same size out, current layer" contract exactly: the mask
 * only ever zeroes alpha, it never changes width/height the way the standalone Real-ESRGAN
 * dialog or the Object Selection tool's own selection output would.
 */
const model = segmentModelById(defaultSegmentModelId);

export default {
  id: "remove-background",
  category: { en: "Portrait", ru: "Портрет" },
  label: { en: "Remove Background", ru: "Удалить фон" },
  ...(model?.note ? { note: model.note } : {}),
  specs: model ? [model.spec] : [],

  async isCached() {
    if (!model) return false;
    return kernel.models.isCached(model.spec);
  },

  async run(pixels, width, height, options) {
    if (!model) return { pixels: null, error: "No segmentation model is registered." };
    const outcome = await runSegmentation(model, pixels, width, height, options);
    if (outcome.error) return { pixels: null, error: outcome.error };
    if (!outcome.mask) return { pixels: null, error: "" };
    const result = pixels.slice();
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const at = pixel * 4 + 3;
      result[at] = Math.round((result[at]! * outcome.mask[pixel]!) / 255);
    }
    return { pixels: result, error: null };
  },
} satisfies NeuralFilterDefinition as NeuralFilterDefinition;
