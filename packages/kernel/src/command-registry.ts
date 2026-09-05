import type { Command, CommandArgs, CommandContext, Disposable } from "./types";

export interface CommandExecution { readonly id: string; readonly args?: CommandArgs }
export type CommandExecutedListener = (execution: CommandExecution) => void;

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  readonly #listeners = new Set<CommandExecutedListener>();

  register(command: Command): Disposable {
    if (this.#commands.has(command.id)) throw new Error(`Command already registered: ${command.id}`);
    this.#commands.set(command.id, command);
    return { dispose: () => this.#commands.delete(command.id) };
  }

  get(id: string): Command | undefined { return this.#commands.get(id); }
  list(): readonly Command[] { return [...this.#commands.values()]; }

  /**
   * Runs a command, and tells anything listening that it ran.
   *
   * The notification is emitted here rather than left to callers because it is
   * what the script recorder subscribes to (stage 9 of
   * docs/migration-plan.md): a recorder that wrapped one caller would miss
   * every command reached another way — a shortcut, a menu, a panel button —
   * and would silently record an incomplete script.
   *
   * Only a command that actually ran is announced. A command refused by
   * `isEnabled` did nothing, and a script that replayed it would either do
   * nothing again or, worse, do something in a state where it is now allowed.
   */
  async execute(id: string, context: CommandContext, args?: CommandArgs): Promise<boolean> {
    const command = this.#commands.get(id);
    if (!command || command.isEnabled?.(context) === false) return false;
    await command.execute(context, args);
    for (const listener of this.#listeners) listener(args ? { id, args } : { id });
    return true;
  }

  /** Notified after each command that actually ran. */
  onExecuted(listener: CommandExecutedListener): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  search(query: string): readonly Command[] {
    const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return this.list();
    return this.list().filter((command) => {
      const haystack = `${command.label} ${command.category} ${command.id}`.toLocaleLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }
}
