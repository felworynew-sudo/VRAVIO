import type { VectorToolDefinition, VectorToolModule } from "./types";

/**
 * Every tool file under `definitions/`, collected without a hand-kept list —
 * the same `import.meta.glob` mechanism `environments/raster/tools/registry.ts`
 * uses, for the same reason CONTRIBUTING.md gives: a new tool is a new file.
 */
const modules = import.meta.glob<VectorToolModule>("./definitions/*.{tsx,ts}", { eager: true });

export const vectorTools: readonly VectorToolDefinition[] = Object.values(modules).map((module) => module.default);
export const vectorToolById = new Map(vectorTools.map((tool) => [tool.id, tool]));
