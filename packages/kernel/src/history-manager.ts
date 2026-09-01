import type { ReversibleOperation } from "./types";

interface HistoryEntry {
  operation: ReversibleOperation;
  timestamp: number;
}

export class HistoryManager {
  readonly #undoStack: HistoryEntry[] = [];
  readonly #redoStack: HistoryEntry[] = [];
  #limit: number;

  constructor(limit = 200) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("History limit must be a positive integer");
    this.#limit = limit;
  }

  get canUndo(): boolean { return this.#undoStack.length > 0; }
  get canRedo(): boolean { return this.#redoStack.length > 0; }
  get undoLabel(): string | null { return this.#undoStack.at(-1)?.operation.label ?? null; }

  async execute(operation: ReversibleOperation, merge = false): Promise<void> {
    await operation.redo();
    const previous = this.#undoStack.at(-1);
    const merged = merge && previous ? previous.operation.mergeWith?.(operation) : null;
    if (merged && previous) previous.operation = merged;
    else this.#undoStack.push({ operation, timestamp: Date.now() });
    this.#redoStack.length = 0;
    if (this.#undoStack.length > this.#limit) this.#undoStack.splice(0, this.#undoStack.length - this.#limit);
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

  clear(): void {
    this.#undoStack.length = 0;
    this.#redoStack.length = 0;
  }
}
