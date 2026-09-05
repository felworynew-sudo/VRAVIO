import type { ModalDefinition, ModalModule } from "./types";

/** Every modal window, discovered from its file — the same catalogue shape as
 * tools, rules, commands and windows. */
const modules = import.meta.glob<ModalModule>("./definitions/*.tsx", { eager: true });

export const modalDefinitions: readonly ModalDefinition<never>[] = Object.entries(modules)
  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  .map(([, module]) => module.default);

export const modalById = new Map(modalDefinitions.map((definition) => [definition.id, definition]));
