import { legacyBilingualLabel } from "../i18n";
import { kernel } from "../kernel";
import { applyShortcutOverrides, rememberDefaultShortcut } from "../shortcuts";
import type { CommandDefinition, CommandModule } from "./types";

/**
 * Every command in the application, discovered from its file.
 *
 * The same `import.meta.glob` catalogue the tools, panels and rules registries
 * already use (docs/migration-plan.md stage 7). Shell-level commands — the
 * ones that mean the same thing whatever kind of document is open — sit in
 * `./definitions`; everything that only makes sense inside one environment
 * sits under that environment, which is what "`commands/definitions/` по
 * средам" asks for.
 *
 * A definition file exports one command or an array of them. Families are
 * grouped by file (all of `layer.*` in `layer.ts`) rather than split one per
 * file the way tools are: a tool is fifty to four hundred lines and a command
 * is one, and a family shares its helpers and its category. What matters is
 * that nothing edits a nine-hundred-line switch to add one — a new family is
 * a new file the glob finds on its own.
 */
const modules = import.meta.glob<CommandModule>(
  ["./definitions/*.ts", "../environments/*/commands/definitions/*.ts"],
  { eager: true },
);

export const commandDefinitions: readonly CommandDefinition[] = Object.entries(modules)
  // Sorted by path, then kept in each file's own declared order: the registry
  // is what the palette lists, and a list whose order depends on how a bundler
  // happened to walk a directory is a list that reorders itself between builds.
  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  .flatMap(([, module]) => (Array.isArray(module.default) ? [...module.default] : [module.default]));

export const commandDefinitionById = new Map(commandDefinitions.map((definition) => [definition.id, definition]));

let registered = false;

/**
 * Puts the catalogue into the kernel, once.
 *
 * `label`/`category` are flattened to the kernel's concatenated-string shape
 * here — one conversion in one place, instead of the `legacyBilingualLabel`
 * call that used to be re-typed at all eighty registration sites. The shortcut
 * bookkeeping is unchanged: defaults are remembered first so the settings
 * dialog can offer "reset to default", then the user's overrides are applied
 * over the top.
 */
export function registerCatalogueCommands(): void {
  if (registered) return;
  registered = true;

  for (const definition of commandDefinitions) {
    // The kernel throws on a duplicate id, and in development this module can
    // be re-evaluated by hot reload while the kernel — a singleton in another
    // module — keeps the commands from the previous evaluation, so the guard
    // above resets while the registry does not. Skipping what is already there
    // makes that survivable. It cannot hide a genuine duplicate in the
    // catalogue: `registry.test.ts` fails on repeated ids before this runs.
    if (kernel.commands.get(definition.id)) continue;
    kernel.commands.register({
      id: definition.id,
      label: legacyBilingualLabel(definition.label),
      category: legacyBilingualLabel(definition.category),
      ...(definition.shortcut ? { shortcut: definition.shortcut } : {}),
      ...(definition.scope ? { scope: definition.scope } : {}),
      ...(definition.isEnabled ? { isEnabled: definition.isEnabled.bind(definition) } : {}),
      execute: definition.execute.bind(definition),
    });
  }

  for (const command of kernel.commands.list()) {
    if (!command.shortcut) continue;
    rememberDefaultShortcut(command.id, command.shortcut);
    kernel.keymap.bind(command.id, command.shortcut, command.scope);
  }
  applyShortcutOverrides();
}
