import type { Command, CommandContext, Disposable } from "./types";

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();

  register(command: Command): Disposable {
    if (this.#commands.has(command.id)) throw new Error(`Command already registered: ${command.id}`);
    this.#commands.set(command.id, command);
    return { dispose: () => this.#commands.delete(command.id) };
  }

  get(id: string): Command | undefined { return this.#commands.get(id); }
  list(): readonly Command[] { return [...this.#commands.values()]; }

  async execute(id: string, context: CommandContext): Promise<boolean> {
    const command = this.#commands.get(id);
    if (!command || command.isEnabled?.(context) === false) return false;
    await command.execute(context);
    return true;
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
