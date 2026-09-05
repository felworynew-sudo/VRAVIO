import type { CommandContext } from "@vravio/kernel";
import { registerCatalogueCommands } from "./commands/registry";
import { useShellStore } from "./store";

/**
 * What is left of the file that used to hold all eighty command
 * registrations in one 327-line function.
 *
 * Stage 7 of docs/migration-plan.md moved the registrations themselves into
 * catalogue files — `commands/definitions/` for the ones that mean the same
 * thing in every environment, `environments/<kind>/commands/definitions/` for
 * the ones that do not — discovered by `commands/registry.ts` the same way
 * tools, panels and rules already are. This file stays as the entry point the
 * shell has always called, so nothing outside had to learn a new name.
 */
export function ensureCommandsRegistered(): void {
  registerCatalogueCommands();
}

export function activeCommandContext(): CommandContext {
  return { activeDocumentId: useShellStore.getState().activeDocumentId };
}

/** Re-exported where it has always been imported from; the implementation now
 * lives beside the raster commands that share it (see its own comment). */
export { changeRasterDocument } from "./environments/raster/commands/document-edits";
