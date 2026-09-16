import type { NeuralFilterDefinition, NeuralFilterModule } from "./types";

/** Same `import.meta.glob` pattern as every other `ml/*` registry — a new neural filter is a new
 * file under `definitions/`, nothing else to register. */
const modules = import.meta.glob<NeuralFilterModule>("./definitions/*.ts", { eager: true });

export const neuralFilters: readonly NeuralFilterDefinition[] = Object.values(modules).map((module) => module.default);

export const neuralFilterById = (id: string | undefined): NeuralFilterDefinition | undefined =>
  neuralFilters.find((filter) => filter.id === id);
