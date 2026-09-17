import type { DenoiseModelDefinition, DenoiseModelModule } from "./types";

/** Same `import.meta.glob` pattern as every other `ml/*` registry — a new
 * denoise model is a new file under `definitions/`, nothing else to change. */
const modules = import.meta.glob<DenoiseModelModule>("./definitions/*.ts", { eager: true });

export const denoiseModels: readonly DenoiseModelDefinition[] = Object.values(modules)
  .map((module) => module.default)
  .sort((a, b) => a.spec.sizeBytes - b.spec.sizeBytes);

export const denoiseModelById = (id: string | undefined): DenoiseModelDefinition | undefined =>
  denoiseModels.find((model) => model.id === id);

export const defaultDenoiseModelId = denoiseModels[0]?.id ?? "";
