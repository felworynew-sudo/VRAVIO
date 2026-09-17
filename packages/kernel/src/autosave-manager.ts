import type { DocumentSnapshotStore } from "./document-snapshot-store";
import type { DocumentStore } from "./document-store";
import type { Disposable, VravioDocument } from "./types";

export interface AutosaveManagerOptions {
  readonly delayMs?: number;
  /**
   * The longest a change may wait for its save while edits keep arriving.
   *
   * A plain trailing debounce restarts on every change, so a session that never pauses for
   * `delayMs` never saves at all — exactly the long uninterrupted session a crash hurts most.
   * Lodash's `debounce` names the same fix `maxWait`.
   */
  readonly maxWaitMs?: number;
}

export class AutosaveManager {
  readonly #documents: DocumentStore;
  readonly #snapshots: DocumentSnapshotStore;
  readonly #delayMs: number;
  readonly #maxWaitMs: number;
  #subscription: Disposable | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #flushPromise: Promise<void> | null = null;
  /** The one save waiting behind `#flushPromise` — however many flushes asked for it meanwhile. */
  #queuedFlush: Promise<void> | null = null;
  /** When the oldest change not yet handed to a save happened. */
  #pendingSince: number | null = null;

  constructor(documents: DocumentStore, snapshots: DocumentSnapshotStore, options: AutosaveManagerOptions = {}) {
    this.#documents = documents;
    this.#snapshots = snapshots;
    this.#delayMs = options.delayMs ?? 1500;
    this.#maxWaitMs = Math.max(this.#delayMs, options.maxWaitMs ?? 10_000);
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
    const now = Date.now();
    this.#pendingSince ??= now;
    if (this.#timer) clearTimeout(this.#timer);
    const delay = Math.max(0, Math.min(this.#delayMs, this.#pendingSince + this.#maxWaitMs - now));
    this.#timer = setTimeout(() => { this.#timer = null; void this.flush(); }, delay);
  }

  flush(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    // A save already on its way to disk took the documents as they were when it started. Handing
    // back that same promise used to mean an edit made meanwhile was silently not saved until some
    // later, unrelated edit happened to schedule another one; chain a fresh save after it instead.
    if (this.#flushPromise) return this.#queuedFlush ??= this.#flushPromise.then(() => { this.#queuedFlush = null; return this.flush(); });
    this.#pendingSince = null;
    const saving = this.#snapshots.saveSession(this.#documents.list()).finally(() => {
      if (this.#flushPromise === saving) this.#flushPromise = null;
    });
    this.#flushPromise = saving;
    return saving;
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pendingSince = null;
    this.#subscription?.dispose();
    this.#subscription = null;
  }
}

