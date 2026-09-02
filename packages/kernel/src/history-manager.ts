import type { Disposable, FreeReason, ReversibleOperation } from "./types";

interface HistoryEntry { operation: ReversibleOperation; timestamp: number }
export interface HistoryManagerOptions {
  readonly limit?: number;
  readonly memoryLimitBytes?: number;
  readonly storageLimitBytes?: number;
  /**
   * Heap fill ratio in 0..1, or null when it cannot be measured.
   *
   * Budgets alone are guesswork: a raster step can weigh 50 MB and the tab dies
   * before the limit is reached. Watching the heap lets the timeline shed weight
   * before that happens — the trick miniPaint uses.
   */
  readonly heapPressure?: () => number | null;
}

/** Above this heap fill ratio the timeline starts shedding old steps. */
const heapPressureLimit = 0.8;

function defaultHeapPressure(): number | null {
  const memory = (globalThis as { performance?: { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } } }).performance?.memory;
  if (!memory?.jsHeapSizeLimit) return null;
  return memory.usedJSHeapSize / memory.jsHeapSizeLimit;
}

/** One row of the history panel timeline: applied steps first, then undone steps still available for redo. */
export interface HistoryEntrySummary {
  readonly position: number;
  readonly label: string;
  readonly timestamp: number;
  readonly applied: boolean;
}

const estimate = (operation: ReversibleOperation, key: "memoryEstimate" | "storageEstimate") => Math.max(0, operation[key] ?? 0);

export class HistoryManager {
  readonly #undoStack: HistoryEntry[] = [];
  readonly #redoStack: HistoryEntry[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #limit: number;
  #memoryLimitBytes: number;
  #storageLimitBytes: number;
  readonly #heapPressure: () => number | null;

  constructor(options: number | HistoryManagerOptions = 200) {
    const normalized = typeof options === "number" ? { limit: options } : options;
    this.#limit = normalized.limit ?? 200;
    this.#memoryLimitBytes = normalized.memoryLimitBytes ?? 512 * 1024 * 1024;
    this.#storageLimitBytes = normalized.storageLimitBytes ?? Number.POSITIVE_INFINITY;
    this.#heapPressure = normalized.heapPressure ?? defaultHeapPressure;
    if (!Number.isInteger(this.#limit) || this.#limit < 1) throw new RangeError("History limit must be a positive integer");
    if (!(this.#memoryLimitBytes > 0) || !(this.#storageLimitBytes > 0)) throw new RangeError("History budgets must be positive");
  }

  get canUndo(): boolean { return this.#undoStack.length > 0; }
  get canRedo(): boolean { return this.#redoStack.length > 0; }
  get undoLabel(): string | null { return this.#undoStack.at(-1)?.operation.label ?? null; }
  get undoCount(): number { return this.#undoStack.length; }
  get redoCount(): number { return this.#redoStack.length; }
  get memoryBytes(): number { return this.#total("memoryEstimate"); }
  get storageBytes(): number { return this.#total("storageEstimate"); }
  /** Number of applied steps; also the timeline cursor used by {@link jumpTo}. */
  get position(): number { return this.#undoStack.length; }

  /**
   * The full timeline, oldest first. The redo stack is LIFO, so it is reversed here to
   * read as "what happens next" rather than "what was undone most recently".
   */
  timeline(): readonly HistoryEntrySummary[] {
    const applied = this.#undoStack.map((entry, index) => ({ position: index + 1, label: entry.operation.label, timestamp: entry.timestamp, applied: true }));
    const undone = [...this.#redoStack].reverse().map((entry, index) => ({ position: applied.length + index + 1, label: entry.operation.label, timestamp: entry.timestamp, applied: false }));
    return [...applied, ...undone];
  }

  /** Moves the cursor to `position` (0 = before the first step) by replaying undo/redo. */
  async jumpTo(position: number): Promise<boolean> {
    const total = this.#undoStack.length + this.#redoStack.length;
    if (!Number.isInteger(position) || position < 0 || position > total) return false;
    while (this.#undoStack.length > position) if (!await this.undo()) return false;
    while (this.#undoStack.length < position) if (!await this.redo()) return false;
    return true;
  }

  subscribe(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  async setBudgets(memoryLimitBytes: number, storageLimitBytes = this.#storageLimitBytes): Promise<void> {
    if (!(memoryLimitBytes > 0) || !(storageLimitBytes > 0)) throw new RangeError("History budgets must be positive");
    this.#memoryLimitBytes = memoryLimitBytes;
    this.#storageLimitBytes = storageLimitBytes;
    await this.#trim();
  }

  async execute(operation: ReversibleOperation, merge = false): Promise<void> {
    await operation.redo();
    const previous = this.#undoStack.at(-1);
    const merged = merge && previous ? previous.operation.mergeWith?.(operation) : null;
    if (merged && previous) previous.operation = merged;
    else this.#undoStack.push({ operation, timestamp: Date.now() });
    await this.#freeEntries(this.#redoStack.splice(0), "discarded");
    await this.#trim();
    this.#notify();
  }

  async executeBatch(label: string, operations: readonly ReversibleOperation[]): Promise<void> {
    const batch: ReversibleOperation = {
      label,
      memoryEstimate: operations.reduce((sum, operation) => sum + estimate(operation, "memoryEstimate"), 0),
      storageEstimate: operations.reduce((sum, operation) => sum + estimate(operation, "storageEstimate"), 0),
      redo: async () => {
        const completed: ReversibleOperation[] = [];
        try {
          for (const operation of operations) { await operation.redo(); completed.push(operation); }
        } catch (error) {
          for (const operation of completed.reverse()) await operation.undo();
          throw error;
        }
      },
      undo: async () => { for (const operation of [...operations].reverse()) await operation.undo(); },
      free: async (reason) => { for (const operation of operations) await operation.free?.(reason); },
    };
    await this.execute(batch);
  }

  async undo(): Promise<boolean> {
    const entry = this.#undoStack.pop();
    if (!entry) return false;
    await entry.operation.undo();
    this.#redoStack.push(entry);
    this.#notify();
    return true;
  }

  async redo(): Promise<boolean> {
    const entry = this.#redoStack.pop();
    if (!entry) return false;
    await entry.operation.redo();
    this.#undoStack.push(entry);
    this.#notify();
    return true;
  }

  async clear(): Promise<void> {
    await this.#freeEntries([...this.#undoStack.splice(0), ...this.#redoStack.splice(0)], "evicted");
    this.#notify();
  }

  async #trim(): Promise<void> {
    const removed: HistoryEntry[] = [];
    const pressure = this.#heapPressure();
    // Under heap pressure shed down to half the current weight instead of
    // waiting for a budget that may never be reached. The target is measured
    // against the live total rather than counted down as entries leave: a step
    // that keeps its buffers in storage weighs nothing on the heap, so a
    // countdown would never be satisfied and would drain the whole timeline.
    const heapTarget =
      pressure !== null && pressure > heapPressureLimit ? this.memoryBytes / 2 : Number.POSITIVE_INFINITY;

    while (
      this.#undoStack.length > 1 &&
      (this.#undoStack.length > this.#limit ||
        this.memoryBytes > this.#memoryLimitBytes ||
        this.storageBytes > this.#storageLimitBytes ||
        this.memoryBytes > heapTarget)
    ) {
      const entry = this.#undoStack.shift();
      if (!entry) break;
      removed.push(entry);
    }
    await this.#freeEntries(removed, "evicted");
  }

  #notify(): void { for (const listener of [...this.#listeners]) listener(); }

  #total(key: "memoryEstimate" | "storageEstimate"): number {
    return [...this.#undoStack, ...this.#redoStack].reduce((sum, entry) => sum + estimate(entry.operation, key), 0);
  }

  async #freeEntries(entries: readonly HistoryEntry[], reason: FreeReason): Promise<void> {
    for (const entry of entries) await entry.operation.free?.(reason);
  }
}
