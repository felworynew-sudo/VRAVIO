import type { CommandArgs, CommandContext } from "@vravio/kernel";
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
 * What a recorded script stores for a step and hands back on playback
 * (docs/migration-plan.md 4.3: "без схемы сценарий нечего записывать и нечем
 * воспроизводить"). The schema is also what `coerceArgs` checks a played-back
 * step against, so a script edited by hand — or written by an older version —
 * cannot feed a command something it never expected.
 *
 * A command that takes no arguments simply omits `args`.
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
  execute(context: CommandContext, args?: CommandArgs): void | Promise<void>;
}

/** What a definition file default-exports; a file may export several. */
export type CommandModule = { default: CommandDefinition | readonly CommandDefinition[] };

/**
 * Reads a step's stored arguments against a command's schema.
 *
 * Returns the values a command can rely on, or `null` when the step cannot be
 * satisfied — an argument missing with no default, a number outside its range,
 * an enum value that is not one of the options. Playback stops on `null`
 * rather than calling the command with something it never expected: a script
 * is stored data, and stored data outlives the code that wrote it. A hand-
 * edited script, or one recorded before an option's range changed, arrives
 * here looking exactly like a fresh one.
 */
export function coerceArgs(schema: ArgSchema | undefined, args: CommandArgs | undefined): CommandArgs | null {
  if (!schema) return args ?? {};
  const out: Record<string, string | number | boolean> = {};

  for (const [name, spec] of Object.entries(schema)) {
    const given = args?.[name];
    const value = given ?? spec.default;
    if (value === undefined) return null;

    switch (spec.kind) {
      case "number": {
        const number = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(number)) return null;
        if (spec.min !== undefined && number < spec.min) return null;
        if (spec.max !== undefined && number > spec.max) return null;
        out[name] = number;
        break;
      }
      case "boolean":
        if (typeof value !== "boolean") return null;
        out[name] = value;
        break;
      case "enum":
        if (typeof value !== "string" || !spec.options.includes(value)) return null;
        out[name] = value;
        break;
      default:
        if (typeof value !== "string") return null;
        out[name] = value;
        break;
    }
  }
  return out;
}
