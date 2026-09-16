import type { InteractiveSelectModelDefinition, InteractiveSelectModelModule } from "./types";

/** Same `import.meta.glob` pattern as `ml/inpaint/registry.ts` and `ml/segment/registry.ts` — a
 * new model is a new file here, nothing else to wire up. */
const modules = import.meta.glob<InteractiveSelectModelModule>("./definitions/*.ts", { eager: true });

export const interactiveSelectModels: readonly InteractiveSelectModelDefinition[] = Object.values(modules)
  .map((module) => module.default)
  .sort((a, b) => (a.encoderSpec.sizeBytes + a.decoderSpec.sizeBytes) - (b.encoderSpec.sizeBytes + b.decoderSpec.sizeBytes));

export const interactiveSelectModelById = (id: string | undefined): InteractiveSelectModelDefinition | undefined =>
  interactiveSelectModels.find((model) => model.id === id);

export const defaultInteractiveSelectModelId = interactiveSelectModels[0]?.id ?? "mobile-sam";
