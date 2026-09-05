import type { BrushPreset, BrushPresetModule } from "./types";

/** Every brush preset, discovered from its file — a new one is a new file. */
const modules = import.meta.glob<BrushPresetModule>("./definitions/*.ts", { eager: true });

export const brushPresets: readonly BrushPreset[] = Object.values(modules)
  .map((module) => module.default)
  .sort((a, b) => a.order - b.order);
