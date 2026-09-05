import type { CommandContext } from "@vravio/kernel";
import type { LocalizedText } from "../i18n";

/**
 * Where the software is allowed to put this command.
 *
 * A command used to appear somewhere because someone typed it into that
 * somewhere: `App.tsx` carried the menu bar as literal arrays of
 * `[label, shortcut, handler]` tuples that had drifted away from the registry
 * they were supposed to mirror — the File menu offered Export on Ctrl+Shift+E
 * while `file.export` was registered on Mod+Shift+Alt+W, and the Layer menu
 * showed a permanently disabled "Merge Down" beside a `layer.mergeDown` that
 * worked. Placement declared by the command itself is the fix: one source,
 * and a new command reaches its menu by existing rather than by being typed
 * out a second time.
 */
export type CommandSurface = "menu" | "palette" | "layer-context" | "canvas-context" | "toolbar";

/**
 * One argument a command accepts.
 *
 * Read by nothing yet — this is the shape stage 9 records into a script and
 * plays back out of one, and it is defined here because that is where
 * docs/migration-plan.md section 4.3 puts it ("без схемы сценарий нечего
 * записывать и нечем воспроизводить"). A command that takes no arguments
 * simply omits `args`, which today is all of them; nothing in stage 7 pretends
 * to consume this.
 */
export type ArgSpec =
  | { readonly kind: "number"; readonly label: LocalizedText; readonly min?: number; readonly max?: number; readonly step?: number; readonly default?: number }
  | { readonly kind: "string"; readonly label: LocalizedText; readonly default?: string }
  | { readonly kind: "boolean"; readonly label: LocalizedText; readonly default?: boolean }
  | { readonly kind: "enum"; readonly label: LocalizedText; readonly options: readonly string[]; readonly default?: string };

export interface ArgSchema { readonly [name: string]: ArgSpec }

/**
 * A command as a catalogue file declares it.
 *
 * The kernel's own `Command` is what this becomes at registration
 * (`registry.ts`): `label`/`category` are structured `LocalizedText` here and
 * are flattened to the kernel's concatenated-string shape on the way in, the
 * same conversion `ensureCommandsRegistered` used to do inline at every one of
 * eighty call sites. See `legacyBilingualLabel` in i18n.ts for why the kernel
 * side still takes a string.
 */
export interface CommandDefinition {
  readonly id: string;
  readonly label: LocalizedText;
  readonly category: LocalizedText;
  readonly shortcut?: string;
  /** Shortcut scope, forwarded to the kernel unchanged — see `Command.scope`. */
  readonly scope?: string;
  readonly surfaces: readonly CommandSurface[];
  readonly args?: ArgSchema;
  /**
   * Never written into a recorded script. For stage 9, and for the same
   * reason recording a macro recorder recording itself is nonsense: the
   * recording commands, playback, and undo/redo.
   */
  readonly neverRecord?: boolean;
  isEnabled?(context: CommandContext): boolean;
  execute(context: CommandContext): void | Promise<void>;
}

/** What a definition file default-exports; a file may export several. */
export type CommandModule = { default: CommandDefinition | readonly CommandDefinition[] };
