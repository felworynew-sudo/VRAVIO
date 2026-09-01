import type { Disposable } from "./types";

export class EventBus<TEvents extends object> {
  readonly #listeners = new Map<keyof TEvents, Set<(payload: never) => void>>();

  on<TKey extends keyof TEvents>(type: TKey, listener: (payload: TEvents[TKey]) => void): Disposable {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener as (payload: never) => void);
    this.#listeners.set(type, listeners);
    return { dispose: () => listeners.delete(listener as (payload: never) => void) };
  }

  emit<TKey extends keyof TEvents>(type: TKey, payload: TEvents[TKey]): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(payload as never);
  }

  clear(): void {
    this.#listeners.clear();
  }
}
