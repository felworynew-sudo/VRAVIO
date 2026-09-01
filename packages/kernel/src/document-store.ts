import { EventBus } from "./event-bus";
import type { Disposable, EnvironmentKind, VravioDocument } from "./types";

interface DocumentEvents {
  changed: { id: string; revision: number };
  opened: { id: string };
  closed: { id: string };
}

export class DocumentStore {
  readonly #documents = new Map<string, VravioDocument>();
  readonly #events = new EventBus<DocumentEvents>();
  #version = 0;

  create<TState>(kind: EnvironmentKind, name: string, state: TState): VravioDocument<TState> {
    const now = Date.now();
    const document: VravioDocument<TState> = {
      id: crypto.randomUUID(), kind, name, state, revision: 0, dirty: false, createdAt: now, updatedAt: now,
    };
    this.#documents.set(document.id, document);
    this.#version += 1;
    this.#events.emit("opened", { id: document.id });
    return document;
  }

  get<TState = unknown>(id: string): VravioDocument<TState> | undefined {
    return this.#documents.get(id) as VravioDocument<TState> | undefined;
  }

  list(): readonly VravioDocument[] {
    return [...this.#documents.values()];
  }

  update<TState>(id: string, mutator: (state: TState) => void): number {
    const document = this.get<TState>(id);
    if (!document) throw new Error(`Unknown document: ${id}`);
    mutator(document.state);
    document.revision += 1;
    document.dirty = true;
    document.updatedAt = Date.now();
    this.#version += 1;
    this.#events.emit("changed", { id, revision: document.revision });
    return document.revision;
  }

  markSaved(id: string): void {
    const document = this.get(id);
    if (!document) throw new Error(`Unknown document: ${id}`);
    document.dirty = false;
    document.updatedAt = Date.now();
    this.#version += 1;
    this.#events.emit("changed", { id, revision: document.revision });
  }

  close(id: string): boolean {
    const closed = this.#documents.delete(id);
    if (closed) {
      this.#version += 1;
      this.#events.emit("closed", { id });
    }
    return closed;
  }

  subscribe(listener: () => void): Disposable {
    const subscriptions = (["changed", "opened", "closed"] as const).map((type) => this.#events.on(type, listener));
    return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
  }

  getVersion(): number {
    return this.#version;
  }
}
