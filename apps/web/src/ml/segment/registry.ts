import type { SegmentModelDefinition, SegmentModelModule } from "./types";

/** Every segmentation model, discovered from its file — a new one is a new
 * file, nothing else to change (same registry shape as `ml/inpaint/registry.ts`). */
const modules = import.meta.glob<SegmentModelModule>("./definitions/*.ts", { eager: true });

export const segmentModels: readonly SegmentModelDefinition[] = Object.values(modules)
  .map((module) => module.default)
  .sort((a, b) => a.spec.sizeBytes - b.spec.sizeBytes);

export const segmentModelById = (id: string | undefined): SegmentModelDefinition | undefined =>
  segmentModels.find((model) => model.id === id);

/** What Quick Actions runs when nothing has been chosen: the lightest one. */
export const defaultSegmentModelId = segmentModels[0]?.id ?? "u2netp";
