import type { ReversibleOperation } from "./types";

interface HistoryEntry { operation: ReversibleOperation; timestamp: number }
export interface HistoryManagerOptions { readonly limit?: number; readonly memoryLimitBytes?: number; readonly storageLimitBytes?: number }

const estimate = (operation: ReversibleOperation, key: "memoryEstimate" | "storageEstimate") => Math.max(0, operation[key] ?? 0);

export class HistoryManager {
  readonly #undoStack: HistoryEntry[] = [];
  readonly #redoStack: HistoryEntry[] = [];
  readonly #limit: number;
  #memoryLimitBytes: number;
  #storageLimitBytes: number;

  constructor(options: number | HistoryManagerOptions = 200) {
    const normalized = typeof options === "number" ? { limit: options } : options;
    this.#limit = normalized.limit ?? 200;
    this.#memoryLimitBytes = normalized.memoryLimitBytes ?? 512 * 1024 * 1024;
    this.#storageLimitBytes = normalized.storageLimitBytes ?? Number.POSITIVE_INFINITY;
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
    await this.#freeEntries(this.#redoStack.splice(0));
    await this.#trim();
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
      free: async () => { for (const operation of operations) await operation.free?.(); },
    };
    await this.execute(batch);
  }

  async undo(): Promise<boolean> {
    const entry = this.#undoStack.pop();
    if (!entry) return false;
    await entry.operation.undo();
    this.#redoStack.push(entry);
    return true;
  }

  async redo(): Promise<boolean> {
    const entry = this.#redoStack.pop();
    if (!entry) return false;
    await entry.operation.redo();
    this.#undoStack.push(entry);
    return true;
  }

  async clear(): Promise<void> {
    await this.#freeEntries([...this.#undoStack.splice(0), ...this.#redoStack.splice(0)]);
  }

  async #trim(): Promise<void> {
    const removed: HistoryEntry[] = [];
    while (this.#undoStack.length > 1 && (this.#undoStack.length > this.#limit || this.memoryBytes > this.#memoryLimitBytes || this.storageBytes > this.#storageLimitBytes)) {
      const entry = this.#undoStack.shift();
      if (entry) removed.push(entry);
    }
    await this.#freeEntries(removed);
  }

  #total(key: "memoryEstimate" | "storageEstimate"): number {
    return [...this.#undoStack, ...this.#redoStack].reduce((sum, entry) => sum + estimate(entry.operation, key), 0);
  }

  async #freeEntries(entries: readonly HistoryEntry[]): Promise<void> {
    for (const entry of entries) await entry.operation.free?.();
  }
}
