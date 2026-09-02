import type { RasterAdjustmentDefinition, RasterAdjustmentModule } from "./types";

const modules = import.meta.glob<RasterAdjustmentModule>("./definitions/*.tsx", { eager: true });

export const rasterAdjustments: readonly RasterAdjustmentDefinition[] = Object.values(modules)
  .map((module) => module.default)
  .sort((a, b) => a.order - b.order);

export const rasterAdjustmentById = new Map(rasterAdjustments.map((definition) => [definition.id, definition]));
