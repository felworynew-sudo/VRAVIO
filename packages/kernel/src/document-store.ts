import { EventBus } from "./event-bus";
import type { AssetId } from "./asset-store";
import type { Disposable, DocumentOrigin, EnvironmentKind, Provenance, VravioDocument } from "./types";

export interface CreateDocumentOptions {
  readonly origin?: DocumentOrigin | null;
  readonly assetRefs?: Iterable<AssetId>;
  readonly provenance?: Provenance | null;
}

interface DocumentEvents {
  changed: { id: string; revision: number };
  opened: { id: string };
  closed: { id: string };
}

export class DocumentStore {
  readonly #documents = new Map<string, VravioDocument>();
  readonly #events = new EventBus<DocumentEvents>();
  #version = 0;

  create<TState>(kind: EnvironmentKind, name: string, state: TState, options: CreateDocumentOptions = {}): VravioDocument<TState> {
    const now = Date.now();
    const document: VravioDocument<TState> = {
      id: crypto.randomUUID(), kind, name, origin: options.origin ?? null, state, assetRefs: new Set(options.assetRefs), provenance: options.provenance ?? null, revision: 0, dirty: false, createdAt: now, updatedAt: now,
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

  setOrigin(id: string, origin: DocumentOrigin | null): void {
    const document = this.get(id);
    if (!document) throw new Error(`Unknown document: ${id}`);
    document.origin = origin;
    this.#touch(document);
  }

  setProvenance(id: string, provenance: Provenance | null): void {
    const document = this.get(id);
    if (!document) throw new Error(`Unknown document: ${id}`);
    document.provenance = provenance;
    this.#touch(document);
  }

  addAssetRef(id: string, assetId: AssetId): boolean {
    const document = this.get(id);
    if (!document) throw new Error(`Unknown document: ${id}`);
    if (document.assetRefs.has(assetId)) return false;
    document.assetRefs.add(assetId);
    this.#touch(document);
    return true;
  }

  removeAssetRef(id: string, assetId: AssetId): boolean {
    const document = this.get(id);
    if (!document) throw new Error(`Unknown document: ${id}`);
    const removed = document.assetRefs.delete(assetId);
    if (removed) this.#touch(document);
    return removed;
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

  #touch(document: VravioDocument): void {
    document.revision += 1;
    document.dirty = true;
    document.updatedAt = Date.now();
    this.#version += 1;
    this.#events.emit("changed", { id: document.id, revision: document.revision });
  }
}
