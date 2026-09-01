export interface WorkerTaskClient<Input, Output> {
  run(input: Input, signal: AbortSignal): Promise<Output>;
  dispose(): void;
}

export interface WorkerPoolRunOptions {
  signal?: AbortSignal;
}

interface QueueEntry<Input, Output> {
  input: Input;
  controller: AbortController;
  resolve(value: Output): void;
  reject(reason: unknown): void;
  detachExternalAbort?(): void;
}

interface WorkerSlot<Input, Output> {
  client: WorkerTaskClient<Input, Output>;
  active: QueueEntry<Input, Output> | null;
}

function abortError(): Error {
  const error = new Error("Worker task was cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Schedules expensive jobs across a bounded set of worker clients.
 * The pool itself is runtime-neutral: the web platform supplies Web Worker
 * clients while desktop builds may supply native/WASM worker clients.
 */
export class WorkerPool<Input, Output> {
  readonly #slots: Array<WorkerSlot<Input, Output>>;
  readonly #queue: Array<QueueEntry<Input, Output>> = [];
  #disposed = false;

  constructor(factory: () => WorkerTaskClient<Input, Output>, size = 4) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError("Worker pool size must be a positive integer");
    this.#slots = Array.from({ length: size }, () => ({ client: factory(), active: null }));
  }

  get size(): number { return this.#slots.length; }
  get activeCount(): number { return this.#slots.filter((slot) => slot.active).length; }
  get queuedCount(): number { return this.#queue.length; }

  run(input: Input, options: WorkerPoolRunOptions = {}): Promise<Output> {
    if (this.#disposed) return Promise.reject(new Error("Worker pool is disposed"));
    if (options.signal?.aborted) return Promise.reject(abortError());

    return new Promise<Output>((resolve, reject) => {
      const controller = new AbortController();
      const entry: QueueEntry<Input, Output> = { input, controller, resolve, reject };
      if (options.signal) {
        const cancel = () => {
          controller.abort();
          const queuedIndex = this.#queue.indexOf(entry);
          if (queuedIndex >= 0) {
            this.#queue.splice(queuedIndex, 1);
            entry.detachExternalAbort?.();
            reject(abortError());
          }
        };
        options.signal.addEventListener("abort", cancel, { once: true });
        entry.detachExternalAbort = () => options.signal?.removeEventListener("abort", cancel);
      }
      this.#queue.push(entry);
      this.#drain();
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#queue.splice(0)) {
      entry.detachExternalAbort?.();
      entry.controller.abort();
      entry.reject(abortError());
    }
    for (const slot of this.#slots) {
      slot.active?.controller.abort();
      slot.client.dispose();
    }
  }

  #drain(): void {
    if (this.#disposed) return;
    for (const slot of this.#slots) {
      if (slot.active) continue;
      const entry = this.#queue.shift();
      if (!entry) return;
      if (entry.controller.signal.aborted) {
        entry.detachExternalAbort?.();
        entry.reject(abortError());
        continue;
      }
      slot.active = entry;
      slot.client.run(entry.input, entry.controller.signal).then(
        (value) => {
          if (entry.controller.signal.aborted) entry.reject(abortError());
          else entry.resolve(value);
        },
        (error) => entry.reject(entry.controller.signal.aborted ? abortError() : error),
      ).finally(() => {
        entry.detachExternalAbort?.();
        slot.active = null;
        this.#drain();
      });
    }
  }
}

