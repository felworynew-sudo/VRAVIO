import { isRasterDocumentState } from "@vravio/env-raster";
import type { DocumentStore, FileSystemPort } from "@vravio/kernel";

/** The one side effect a linked-object watcher is allowed to perform.
 * Keeping it injected makes the watcher about lifecycle/coalescing only; the
 * raster command remains the single place that decodes and replaces sources. */
export type RefreshLinkedPath = (documentId: string, path: string) => Promise<void>;

/**
 * Owns native watches for the externally linked Smart Objects currently open
 * in VRAVIO. There is at most one OS watch per absolute path, even if it has
 * ten placements or appears in several documents. Documents are rescanned
 * after edits, so Place Linked, Relink, Embed and Close require no bespoke
 * watcher calls and cannot leave stale handles behind.
 */
export class LinkedSmartObjectWatcher {
  readonly #documents: DocumentStore;
  readonly #fs: FileSystemPort;
  readonly #refresh: RefreshLinkedPath;
  readonly #unwatchByPath = new Map<string, () => void>();
  #ownersByPath = new Map<string, Set<string>>();
  #subscription: { dispose(): void } | null = null;
  #reconcileQueued = false;
  #disposed = false;
  readonly #watchingPaths = new Set<string>();
  readonly #refreshingPaths = new Set<string>();
  readonly #refreshAgain = new Set<string>();

  constructor(documents: DocumentStore, fs: FileSystemPort, refresh: RefreshLinkedPath) {
    this.#documents = documents;
    this.#fs = fs;
    this.#refresh = refresh;
  }

  start(): void {
    if (this.#subscription || !this.#fs.watchExternalFile) return;
    this.#subscription = this.#documents.subscribe(() => this.#scheduleReconcile());
    this.#scheduleReconcile();
  }

  dispose(): void {
    this.#disposed = true;
    this.#subscription?.dispose();
    this.#subscription = null;
    for (const unwatch of this.#unwatchByPath.values()) unwatch();
    this.#unwatchByPath.clear();
    this.#ownersByPath.clear();
    this.#watchingPaths.clear();
  }

  #scheduleReconcile(): void {
    if (this.#disposed || this.#reconcileQueued) return;
    this.#reconcileQueued = true;
    queueMicrotask(() => {
      this.#reconcileQueued = false;
      void this.#reconcile();
    });
  }

  async #reconcile(): Promise<void> {
    if (this.#disposed || !this.#fs.watchExternalFile) return;
    const nextOwners = new Map<string, Set<string>>();
    for (const document of this.#documents.list()) {
      if (!isRasterDocumentState(document.state)) continue;
      for (const layer of document.state.layers) {
        const path = layer.kind === "smart" && layer.smartSource?.mode === "linked" ? layer.smartSource.linkedPath : undefined;
        if (!path) continue;
        const owners = nextOwners.get(path) ?? new Set<string>();
        owners.add(document.id);
        nextOwners.set(path, owners);
      }
    }
    this.#ownersByPath = nextOwners;

    for (const [path, unwatch] of this.#unwatchByPath) {
      if (nextOwners.has(path)) continue;
      unwatch();
      this.#unwatchByPath.delete(path);
    }
    for (const path of nextOwners.keys()) {
      if (this.#unwatchByPath.has(path) || this.#watchingPaths.has(path)) continue;
      void this.#watch(path);
    }
  }

  async #watch(path: string): Promise<void> {
    this.#watchingPaths.add(path);
    try {
      const unwatch = await this.#fs.watchExternalFile?.(path, () => this.#refreshPath(path));
      // A document could have been closed/relinked while the async native watch
      // registration was pending. Do not leak that completed registration.
      if (!unwatch) return;
      if (this.#disposed || !this.#ownersByPath.has(path) || this.#unwatchByPath.has(path)) {
        unwatch();
        return;
      }
      this.#unwatchByPath.set(path, unwatch);
    } finally {
      this.#watchingPaths.delete(path);
    }
  }

  async #refreshPath(path: string): Promise<void> {
    if (this.#disposed || !this.#ownersByPath.has(path)) return;
    // Native applications often write a temporary file and rename it over the
    // original, yielding a short burst of notifications. One refresh at a
    // time preserves one coherent undo entry per document; remember one final
    // event if a write arrives while decoding the preceding one.
    if (this.#refreshingPaths.has(path)) { this.#refreshAgain.add(path); return; }
    this.#refreshingPaths.add(path);
    try {
      do {
        this.#refreshAgain.delete(path);
        await Promise.all([...this.#ownersByPath.get(path) ?? []].map((documentId) => this.#refresh(documentId, path).catch(() => undefined)));
      } while (this.#refreshAgain.delete(path));
    } finally {
      this.#refreshingPaths.delete(path);
    }
  }
}
