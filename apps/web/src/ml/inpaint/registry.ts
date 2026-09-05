import type { InpaintModelDefinition, InpaintModelModule } from "./types";

/** Every inpainting model, discovered from its file — a new one is a new file
 * and a new entry in the brush's model list, with nothing else to change. */
const modules = import.meta.glob<InpaintModelModule>("./definitions/*.ts", { eager: true });

export const inpaintModels: readonly InpaintModelDefinition[] = Object.values(modules)
  .map((module) => module.default)
  .sort((a, b) => a.spec.sizeBytes - b.spec.sizeBytes);

export const inpaintModelById = (id: string | undefined): InpaintModelDefinition | undefined =>
  inpaintModels.find((model) => model.id === id);

/** What the brush offers when nothing has been chosen: the cheapest one. */
export const defaultInpaintModelId = inpaintModels[0]?.id ?? "mi-gan-512";
