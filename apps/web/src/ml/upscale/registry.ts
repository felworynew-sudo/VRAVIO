import type { UpscaleModelDefinition, UpscaleModelModule } from "./types";

/** Every upscaling model, discovered from its file — same `import.meta.glob`
 * pattern as `ml/inpaint/registry.ts` and `ml/segment/registry.ts`: a new
 * model is a new file and a new entry in the dialog's list, nothing else. */
const modules = import.meta.glob<UpscaleModelModule>("./definitions/*.ts", { eager: true });

export const upscaleModels: readonly UpscaleModelDefinition[] = Object.values(modules)
  .map((module) => module.default)
  .sort((a, b) => a.spec.sizeBytes - b.spec.sizeBytes);

export const upscaleModelById = (id: string | undefined): UpscaleModelDefinition | undefined =>
  upscaleModels.find((model) => model.id === id);

export const defaultUpscaleModelId = upscaleModels[0]?.id ?? "real-esrgan-general-x4v3";
