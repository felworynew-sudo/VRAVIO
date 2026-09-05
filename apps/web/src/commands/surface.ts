import type { CommandContext } from "@vravio/kernel";
import { resolveLabel } from "../i18n";
import type { Language } from "../store";
import { kernel } from "../kernel";
import { commandDefinitions } from "./registry";
import type { CommandSurface } from "./types";

/**
 * The commands that belong on one surface, ready to be rendered as menu items.
 *
 * This is what `surfaces` is for. Before it, a place that wanted to offer a
 * command re-typed its label there — and the copies drifted: the layer panel's
 * right-click menu offered "Merge Down (Объединить с нижним)" while the
 * command itself read "Объединить с предыдущим", two different Russian names
 * for one operation, each looking authoritative in its own corner of the UI.
 * A surface asks for its commands now and gets the labels the catalogue holds.
 *
 * `isEnabled` comes along for the same reason. The layer menu greyed Ungroup
 * out for anything that was not a group; the command did not know that, so the
 * palette happily offered it and it did nothing. Whichever surface a command
 * is reached from, it is enabled or not for the same reason.
 */
export interface SurfaceCommand {
  readonly id: string;
  readonly label: string;
  /** Ready to display: `Mod` resolved to this platform's modifier. */
  readonly shortcut: string;
  readonly enabled: boolean;
  run(): void;
}

/**
 * `Mod` is what the keymap binds and what the settings dialog shows, because
 * that is the name of the binding. A menu shows the key the user actually
 * presses.
 */
export function displayShortcut(shortcut: string | undefined): string {
  if (!shortcut) return "";
  const mod = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
  return shortcut.replace(/\bMod\b/g, mod);
}

export function commandsForSurface(surface: CommandSurface, context: CommandContext, language: Language): readonly SurfaceCommand[] {
  return commandDefinitions
    .filter((definition) => definition.surfaces.includes(surface))
    .map((definition) => ({
      id: definition.id,
      label: resolveLabel(definition.label, language),
      shortcut: displayShortcut(definition.shortcut),
      // Asked of the definition rather than the registered command so a
      // surface built before `registerCatalogueCommands` ran still answers.
      enabled: definition.isEnabled?.(context) ?? true,
      run: () => { void kernel.commands.execute(definition.id, context); },
    }));
}

/** The subset in a fixed order, for a surface that wants to lay its own out. */
export function pickCommands(surface: CommandSurface, ids: readonly string[], context: CommandContext, language: Language): readonly SurfaceCommand[] {
  const available = new Map(commandsForSurface(surface, context, language).map((command) => [command.id, command]));
  return ids.flatMap((id) => {
    const command = available.get(id);
    // A silent gap here would be a menu item that vanished because someone
    // renamed a command or dropped the surface from its definition.
    if (!command) throw new Error(`Command "${id}" is not on the "${surface}" surface`);
    return [command];
  });
}
