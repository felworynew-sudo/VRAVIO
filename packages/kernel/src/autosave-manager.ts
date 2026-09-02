import type { DocumentSnapshotStore } from "./document-snapshot-store";
import type { DocumentStore } from "./document-store";
import type { Disposable, VravioDocument } from "./types";

export interface AutosaveManagerOptions { readonly delayMs?: number }

export class AutosaveManager {
  readonly #documents: DocumentStore;
  readonly #snapshots: DocumentSnapshotStore;
  readonly #delayMs: number;
  #subscription: Disposable | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #flushPromise: Promise<void> | null = null;

  constructor(documents: DocumentStore, snapshots: DocumentSnapshotStore, options: AutosaveManagerOptions = {}) {
    this.#documents = documents;
    this.#snapshots = snapshots;
    this.#delayMs = options.delayMs ?? 1500;
  }

  async restore(): Promise<readonly VravioDocument[]> {
    const restored = await this.#snapshots.loadSession();
    for (const document of restored) this.#documents.restore(document);
    return restored;
  }

  start(): void {
    if (this.#subscription) return;
    this.#subscription = this.#documents.subscribe(() => this.schedule());
  }

  schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = null; void this.flush(); }, this.#delayMs);
  }

  flush(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (this.#flushPromise) return this.#flushPromise;
    this.#flushPromise = this.#snapshots.saveSession(this.#documents.list()).finally(() => { this.#flushPromise = null; });
    return this.#flushPromise;
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#subscription?.dispose();
    this.#subscription = null;
  }
}

