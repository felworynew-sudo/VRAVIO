import { kernel } from "../../../kernel";
import { runDenoise } from "../../denoise/run";
import { defaultDenoiseModelId, denoiseModelById } from "../../denoise/registry";
import type { NeuralFilterDefinition } from "../types";

/**
 * AI Denoise as a Neural Filters entry — docs/master-plan.md §52.6, the same
 * `runDenoise`/RealPLKSR model Filter → Noise → AI Denoise and Camera Raw's
 * own Detail panel call, through this panel's own door too (the same "one
 * engine, several doors" precedent `remove-background.ts`'s own comment
 * documents). Fits this panel's "same size in, same size out, current
 * layer" contract exactly — a whole-image denoise never changes width or
 * height.
 */
const model = denoiseModelById(defaultDenoiseModelId);

export default {
  id: "ai-denoise",
  category: { en: "Noise & Restoration", ru: "Шум и восстановление" },
  label: model ? model.label : { en: "AI Denoise", ru: "ИИ подавление шума" },
  ...(model?.note ? { note: model.note } : {}),
  specs: model ? [model.spec] : [],

  async isCached() {
    if (!model) return false;
    return kernel.models.isCached(model.spec);
  },

  async run(pixels, width, height, options) {
    if (!model) return { pixels: null, error: "No denoise model is registered." };
    const outcome = await runDenoise(model, pixels, width, height, options);
    if (!outcome.pixels) return { pixels: null, error: outcome.error ?? "" };
    return { pixels: outcome.pixels, error: null };
  },
} satisfies NeuralFilterDefinition as NeuralFilterDefinition;
