import { EventBus } from "./event-bus";
import { MemoryStorageAdapter, type BinaryStorageAdapter } from "./storage-adapter";
import type { Disposable } from "./types";

export type AssetId = string & { readonly __brand: "AssetId" };
export type AssetKind = "image" | "vector" | "audio" | "video" | "font" | "model3d" | "lut" | "binary";

export interface AssetRevision {
  readonly rev: number;
  readonly storageKey: string;
  readonly bytes: number;
  readonly hash: string;
  readonly createdAt: number;
  readonly producedBy: string;
  readonly note?: string;
}

export interface AssetRecord {
  readonly id: AssetId;
  readonly kind: AssetKind;
  readonly mime: string;
  readonly name: string;
  readonly revisions: AssetRevision[];
  head: number;
  refCount: number;
  readonly meta: Record<string, unknown>;
}

export interface ImportAssetOptions {
  readonly kind: AssetKind;
  readonly mime?: string;
  readonly name: string;
  readonly producedBy?: string;
  readonly meta?: Record<string, unknown>;
}

interface AssetStoreEvents {
  imported: { assetId: AssetId };
  revised: { assetId: AssetId; rev: number; producedBy: string; note?: string };
  deleted: { assetId: AssetId };
}

interface HashEntry { readonly assetId: AssetId; readonly rev: number }

const INDEX_KEY = "asset-index.v1.json";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(data: Uint8Array): Promise<string> {
  const owned = data.slice();
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer)));
}

function extensionOf(name: string, mime: string): string {
  const fromName = name.match(/\.([a-z0-9]{1,12})$/i)?.[1]?.toLocaleLowerCase();
  if (fromName) return fromName;
  const known: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "audio/wav": "wav", "audio/mpeg": "mp3", "video/mp4": "mp4", "font/woff2": "woff2", "application/json": "json" };
  return known[mime] ?? "bin";
}

function optionalNote(note: string | undefined): { note?: string } { return note === undefined ? {} : { note }; }

/** Metadata changes how an asset is interpreted, so byte equality alone is
 * never enough reason to merge two imports. JSON is also the persistence
 * boundary for `meta`, making this deliberately conservative comparison a
 * safe compatibility rule. */
function sameMeta(left: Record<string, unknown>, right: Record<string, unknown> | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right ?? {});
}

export class AssetStore {
  readonly #records = new Map<AssetId, AssetRecord>();
  /** Every revision remains indexed; imports accept only a compatible current head. */
  readonly #hashIndex = new Map<string, HashEntry[]>();
  readonly #adapter: BinaryStorageAdapter;
  readonly #events = new EventBus<AssetStoreEvents>();
  #initialized = false;
  #persistQueue: Promise<void> = Promise.resolve();

  constructor(adapter: BinaryStorageAdapter = new MemoryStorageAdapter()) { this.#adapter = adapter; }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const stored = await this.#adapter.get(INDEX_KEY);
    if (stored) {
      const records = JSON.parse(decoder.decode(stored)) as AssetRecord[];
      for (const record of records) {
        this.#records.set(record.id, record);
        for (const revision of record.revisions) this.#indexRevision(revision.hash, record.id, revision.rev);
      }
    }
    this.#initialized = true;
  }

  async importAsset(data: Blob | Uint8Array, options: ImportAssetOptions): Promise<AssetId> {
    await this.initialize();
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(await data.arrayBuffer());
    const mime = (options.mime ?? (data instanceof Blob ? data.type : "")) || "application/octet-stream";
    const hash = await sha256(bytes);
    const duplicate = (this.#hashIndex.get(hash) ?? [])
      .map(({ assetId, rev }) => ({ record: this.#records.get(assetId), rev }))
      .find(({ record, rev }) => record !== undefined
        && record.head === rev
        && record.kind === options.kind
        && record.mime === mime
        && sameMeta(record.meta, options.meta))?.record;
    if (duplicate) {
      duplicate.refCount += 1;
      await this.#persist();
      return duplicate.id;
    }
    const id = crypto.randomUUID() as AssetId;
    const storageKey = `${id}/0.${extensionOf(options.name, mime)}`;
    await this.#adapter.set(storageKey, bytes);
    const revision: AssetRevision = { rev: 0, storageKey, bytes: bytes.byteLength, hash, createdAt: Date.now(), producedBy: options.producedBy ?? "import" };
    const record: AssetRecord = { id, kind: options.kind, mime, name: options.name, revisions: [revision], head: 0, refCount: 1, meta: { ...options.meta } };
    this.#records.set(id, record);
    this.#indexRevision(hash, id, 0);
    await this.#persist();
    this.#events.emit("imported", { assetId: id });
    return id;
  }

  /** Compatibility helper for early callers; new code should use importAsset. */
  async put(data: Uint8Array, mime = "application/octet-stream"): Promise<AssetRecord> {
    const id = await this.importAsset(data, { kind: mime.startsWith("image/") ? "image" : "binary", mime, name: `asset.${extensionOf("", mime)}` });
    return this.mustGet(id);
  }

  async commitRevision(id: AssetId, data: Blob | Uint8Array, producedBy: string, note?: string): Promise<number> {
    await this.initialize();
    const record = this.mustGet(id);
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(await data.arrayBuffer());
    const rev = Math.max(...record.revisions.map((revision) => revision.rev), -1) + 1;
    const storageKey = `${id}/${rev}.${extensionOf(record.name, record.mime)}`;
    await this.#adapter.set(storageKey, bytes);
    const revision: AssetRevision = { rev, storageKey, bytes: bytes.byteLength, hash: await sha256(bytes), createdAt: Date.now(), producedBy, ...optionalNote(note) };
    record.revisions.push(revision);
    record.head = rev;
    this.#indexRevision(revision.hash, id, rev);
    await this.#persist();
    this.#events.emit("revised", { assetId: id, rev, producedBy, ...optionalNote(note) });
    return rev;
  }

  async read(id: AssetId, rev?: number): Promise<Uint8Array | null> {
    await this.initialize();
    const record = this.mustGet(id), revision = record.revisions.find((item) => item.rev === (rev ?? record.head));
    if (!revision) throw new RangeError(`Unknown asset revision: ${id}@${rev}`);
    return this.#adapter.get(revision.storageKey);
  }

  /**
   * Points the asset at a revision that already exists.
   *
   * This is how undo and redo work for destructive pixel edits: the bytes stay
   * where they are and only the head moves, so a stroke costs one revision
   * rather than a full snapshot pair.
   */
  async setHead(id: AssetId, rev: number, producedBy = "undo"): Promise<void> {
    await this.initialize();
    const record = this.mustGet(id);
    if (!record.revisions.some((revision) => revision.rev === rev)) throw new RangeError(`Unknown asset revision: ${id}@${rev}`);
    if (record.head === rev) return;
    record.head = rev;
    await this.#persist();
    this.#events.emit("revised", { assetId: id, rev, producedBy });
  }

  async rollback(id: AssetId, toRev: number): Promise<void> {
    await this.setHead(id, toRev, "undo");
  }

  /**
   * Collects a revision the history can no longer reach.
   *
   * Every brush stroke commits a full-layer revision, so without collection the
   * storage grows for the whole session. The current head and the last surviving
   * revision are never touched: dropping either would leave a document with no
   * bytes to draw.
   */
  async dropRevision(id: AssetId, rev: number): Promise<boolean> {
    await this.initialize();
    const record = this.#records.get(id);
    if (!record || record.head === rev || record.revisions.length <= 1) return false;

    const index = record.revisions.findIndex((revision) => revision.rev === rev);
    if (index === -1) return false;

    const [removed] = record.revisions.splice(index, 1);
    if (removed) await this.#adapter.remove(removed.storageKey);
    // Rebuilt rather than keyed out: two revisions can share a hash, and
    // deleting by hash would unmap one that is still stored.
    this.#rebuildHashIndex();
    await this.#persist();
    return true;
  }

  /**
   * Drops every revision no longer reachable, keeping only each asset's head.
   *
   * Undo history is what makes an older revision reachable, and history lives
   * only as long as the session. After a reload the revisions behind the head
   * have nothing pointing at them and nothing that will ever collect them, so a
   * layer edited across a few sessions accumulates its whole past in storage.
   * Call this once at startup, before any history exists — calling it later
   * would collect the very revisions the open timeline is holding.
   */
  async collectUnreachableRevisions(): Promise<number> {
    await this.initialize();
    let collected = 0;
    for (const record of [...this.#records.values()]) {
      for (const revision of [...record.revisions]) {
        if (revision.rev !== record.head && (await this.dropRevision(record.id, revision.rev))) collected += 1;
      }
    }
    return collected;
  }

  async retain(id: AssetId): Promise<number> { const record = this.mustGet(id); record.refCount += 1; await this.#persist(); return record.refCount; }
  async release(id: AssetId): Promise<number> { const record = this.mustGet(id); record.refCount = Math.max(0, record.refCount - 1); await this.#persist(); return record.refCount; }
  get(id: AssetId | string): AssetRecord | undefined { return this.#records.get(id as AssetId); }
  has(id: AssetId | string): boolean { return this.#records.has(id as AssetId); }
  list(): readonly AssetRecord[] { return [...this.#records.values()]; }
  get size(): number { return this.#records.size; }

  async delete(id: AssetId, force = false): Promise<boolean> {
    await this.initialize();
    const record = this.#records.get(id);
    if (!record || (!force && record.refCount > 0)) return false;
    await Promise.all(record.revisions.map((revision) => this.#adapter.remove(revision.storageKey)));
    this.#records.delete(id);
    this.#rebuildHashIndex();
    await this.#persist();
    this.#events.emit("deleted", { assetId: id });
    return true;
  }

  subscribe<Type extends keyof AssetStoreEvents>(type: Type, listener: (payload: AssetStoreEvents[Type]) => void): Disposable {
    return this.#events.on(type, listener);
  }

  mustGet(id: AssetId): AssetRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Unknown asset: ${id}`);
    return record;
  }

  #rebuildHashIndex(): void {
    this.#hashIndex.clear();
    for (const record of this.#records.values()) for (const revision of record.revisions) this.#indexRevision(revision.hash, record.id, revision.rev);
  }

  #indexRevision(hash: string, assetId: AssetId, rev: number): void {
    const entries = this.#hashIndex.get(hash) ?? [];
    entries.push({ assetId, rev });
    this.#hashIndex.set(hash, entries);
  }

  async #persist(): Promise<void> {
    const snapshot = encoder.encode(JSON.stringify([...this.#records.values()]));
    this.#persistQueue = this.#persistQueue.catch(() => undefined).then(() => this.#adapter.set(INDEX_KEY, snapshot));
    await this.#persistQueue;
  }
}
