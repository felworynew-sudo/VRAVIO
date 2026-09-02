import type { Disposable } from "./types";

type AnyListener = (payload: never) => void;

const reportToConsole = (error: unknown, type: PropertyKey): void => {
  console.error(`[EventBus] listener for "${String(type)}" failed:`, error);
};

export class EventBus<TEvents extends object> {
  readonly #listeners = new Map<keyof TEvents, Set<AnyListener>>();
  #onError: (error: unknown, type: keyof TEvents) => void = reportToConsole;

  on<TKey extends keyof TEvents>(type: TKey, listener: (payload: TEvents[TKey]) => void): Disposable {
    const listeners = this.#listeners.get(type) ?? new Set<AnyListener>();
    const entry = listener as AnyListener;
    listeners.add(entry);
    this.#listeners.set(type, listeners);
    return {
      dispose: () => {
        const current = this.#listeners.get(type);
        current?.delete(entry);
        if (current && current.size === 0) this.#listeners.delete(type);
      },
    };
  }

  once<TKey extends keyof TEvents>(type: TKey, listener: (payload: TEvents[TKey]) => void): Disposable {
    const subscription = this.on(type, (payload) => { subscription.dispose(); listener(payload); });
    return subscription;
  }

  /** Where listener exceptions go. Defaults to the console. */
  onListenerError(handler: (error: unknown, type: keyof TEvents) => void): void {
    this.#onError = handler;
  }

  emit<TKey extends keyof TEvents>(type: TKey, payload: TEvents[TKey]): void {
    const listeners = this.#listeners.get(type);
    if (!listeners || listeners.size === 0) return;

    // Snapshot before dispatch. A listener is free to subscribe or unsubscribe
    // while it runs: iterating the live set would skip an unvisited sibling
    // that was just removed, and would deliver this same event to a listener
    // that only registered during the round.
    for (const listener of [...listeners]) {
      try {
        (listener as (value: TEvents[TKey]) => void)(payload);
      } catch (error) {
        // One broken subscriber must not silence the rest of the application.
        this.#onError(error, type);
      }
    }
  }

  listenerCount(type: keyof TEvents): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  clear(): void {
    this.#listeners.clear();
  }
}
