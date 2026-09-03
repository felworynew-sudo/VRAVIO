import type { RasterToolDefinition, RasterToolModule } from "./types";

/**
 * Every tool file under `definitions/`, collected without a hand-kept list —
 * the same mechanism `raster-core-panels` and `raster-adjustments` already
 * use, and the reason CONTRIBUTING.md gives for preferring a glob over a
 * registration call: a new tool is a new file, and nothing else.
 */
const modules = import.meta.glob<RasterToolModule>("./definitions/*.{tsx,ts}", { eager: true });

export const rasterTools: readonly RasterToolDefinition[] = Object.values(modules).map((module) => module.default);
export const rasterToolById = new Map(rasterTools.map((tool) => [tool.id, tool]));
