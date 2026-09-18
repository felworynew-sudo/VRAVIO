import type { BinaryStorageAdapter } from "./storage-adapter";
import type { VravioDocument } from "./types";

interface SessionEntry { readonly id: string; readonly revision: number; readonly snapshotKey: string }
interface SessionManifest { readonly schemaVersion: 1; readonly savedAt: number; readonly documents: readonly SessionEntry[] }
interface SnapshotEnvelope {
  readonly schemaVersion: 1;
  readonly document: Omit<VravioDocument, "state" | "assetRefs"> & { assetRefs: string[]; state: unknown };
  readonly binaryCount: number;
  /** Where each binary lives. Absent in snapshots written before binaries were reused. */
  readonly binaryKeys?: readonly string[];
}

type TypedArray = Uint8Array | Uint8ClampedArray | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/**
 * One buffer on its way to storage, and the name its owner knows its content by.
 *
 * `contentKey` comes from `TileStore.toJSON` and is the fix for the regression §60 measured: a
 * tiled layer materialises a *fresh* flat buffer on every save, so deciding "has this changed?"
 * from the buffer's own identity always answered yes, and every autosave rewrote every layer of
 * every open document — 61.8 MB per save on a six-layer 3000x3000 file with nothing edited.
 * Buffers with no owner to name them (a selection mask, an asset) keep the identity rule, which is
 * still correct for them: they really are replaced wholesale when they change.
 */
interface SerializedBinary {
  /** The bytes, or a thunk for them — a chunk whose content is already on disk is never asked. */
  readonly view?: TypedArray;
  readonly bytes?: () => TypedArray;
  readonly contentKey?: string;
}

/** What an owner hands over instead of a buffer when it can name and defer its pieces
 *  (`TileStore.toJSON`'s chunks). Duck-typed rather than imported: the kernel does not depend on
 *  the raster package, and this is a contract, not a class. */
interface ChunkHandle { readonly __vravioChunk: true; readonly contentKey: string; readonly rect: unknown; readonly arrayType: string; readonly bytes: () => TypedArray }
const isChunkHandle = (value: unknown): value is ChunkHandle =>
  typeof value === "object" && value !== null && (value as { __vravioChunk?: unknown }).__vravioChunk === true;
const SESSION_KEY = "autosave/session.v1.json";
/**
 * How rarely storage is *enumerated*. Infinity means once per session, which is the honest answer:
 * the walk exists to find files a previous run left behind, and everything this run writes is
 * already tracked. Repeating it on a timer bought nothing and cost 10+ seconds each time
 * (master-plan §63). A storage wipe is still noticed — by one `get` of the manifest, per save.
 */
const RECONCILE_INTERVAL_MS = Number.POSITIVE_INFINITY;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const typedArrayFactories: Record<string, (buffer: ArrayBuffer) => TypedArray> = {
  Uint8Array: (buffer) => new Uint8Array(buffer),
  Uint8ClampedArray: (buffer) => new Uint8ClampedArray(buffer),
  Uint16Array: (buffer) => new Uint16Array(buffer),
  Int16Array: (buffer) => new Int16Array(buffer),
  Uint32Array: (buffer) => new Uint32Array(buffer),
  Int32Array: (buffer) => new Int32Array(buffer),
  Float32Array: (buffer) => new Float32Array(buffer),
  Float64Array: (buffer) => new Float64Array(buffer),
};

/**
 * Splits a document into a JSON envelope and the buffers it points at.
 *
 * The buffers are handed back as the views the document holds, not as copies.
 * Copying them here meant a quarter of a gigabyte of memcpy on every autosave
 * of a thirty-layer file, before a single byte was written; and it destroyed
 * the identity the caller needs to tell which buffers actually changed.
 */
function serializeDocument(document: VravioDocument): { envelope: SnapshotEnvelope; binaries: SerializedBinary[] } {
  const binaries: SerializedBinary[] = [];
  // A plain function, not an arrow: `this` is the object the value was read from, which is how a
  // buffer's `contentKey` (written next to it by `TileStore.toJSON`) reaches the writer below.
  const state = JSON.parse(JSON.stringify(document.state, function (this: Record<string, unknown>, _key: string, value: unknown) {
    if (isChunkHandle(value)) {
      const index = binaries.push({ bytes: value.bytes, contentKey: value.contentKey }) - 1;
      return { __vravio: "chunk", index, arrayType: value.arrayType, rect: value.rect, contentKey: value.contentKey };
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const view = value as TypedArray;
      const contentKey = typeof this?.contentKey === "string" ? this.contentKey : undefined;
      const index = binaries.push({ view, ...(contentKey ? { contentKey } : {}) }) - 1;
      return { __vravio: "typed-array", index, arrayType: view.constructor.name };
    }
    if (value instanceof ArrayBuffer) {
      const index = binaries.push({ view: new Uint8Array(value) }) - 1;
      return { __vravio: "array-buffer", index };
    }
    if (value instanceof Set) return { __vravio: "set", values: [...value] };
    return value;
  })) as unknown;
  const envelope: SnapshotEnvelope = {
    schemaVersion: 1,
    binaryCount: binaries.length,
    document: {
      id: document.id, name: document.name, kind: document.kind, origin: document.origin,
      state, assetRefs: [...document.assetRefs], provenance: document.provenance,
      revision: document.revision, dirty: document.dirty, createdAt: document.createdAt, updatedAt: document.updatedAt,
    },
  };
  return { envelope, binaries };
}

function deserializeDocument(envelope: SnapshotEnvelope, binaries: readonly Uint8Array[]): VravioDocument {
  const state = JSON.parse(JSON.stringify(envelope.document.state), (_key, value: unknown) => {
    if (!value || typeof value !== "object" || !("__vravio" in value)) return value;
    const marker = value as { __vravio: string; index?: number; arrayType?: string; values?: unknown[]; rect?: unknown; contentKey?: string };
    if (marker.__vravio === "set") return new Set(marker.values ?? []);
    if (marker.index === undefined) throw new Error("Invalid binary marker in document snapshot");
    const bytes = binaries[marker.index];
    if (!bytes) throw new Error(`Missing binary ${marker.index} in document snapshot`);
    const buffer = bytes.slice().buffer;
    if (marker.__vravio === "array-buffer") return buffer;
    const factory = marker.arrayType ? typedArrayFactories[marker.arrayType] : undefined;
    if (!factory) throw new Error(`Unsupported typed array: ${marker.arrayType ?? "unknown"}`);
    // A chunk comes back as the piece its owner handed over — where it goes and what it is called,
    // beside its bytes — because that is what lets the owner put itself back together.
    if (marker.__vravio === "chunk") return { rect: marker.rect, contentKey: marker.contentKey, pixels: factory(buffer) };
    return factory(buffer);
  }) as unknown;
  return { ...envelope.document, state, assetRefs: new Set(envelope.document.assetRefs) } as VravioDocument;
}

const binaryIdOf = (key: string): number => {
  const match = /\/binaries\/(\d+)\.bin$/.exec(key);
  return match ? Number(match[1]) : -1;
};

/**
 * Re-links restored buffers to the keys they were read from, in document order.
 *
 * Content-named buffers are re-linked by name instead: a restored `TileStore` adopts the name its
 * snapshot carried, so the first autosave after a session reload recognises it and writes nothing.
 * Without this the reload itself cost a full rewrite of every document that was open.
 */
function rememberRestoredBinaries(document: VravioDocument, keys: readonly string[], into: WeakMap<ArrayBufferView, string>, byContent: Map<string, string>): void {
  let index = 0;
  JSON.stringify(document.state, function (this: Record<string, unknown>, _key: string, value: unknown) {
    if (isChunkHandle(value)) {
      const key = keys[index];
      index += 1;
      if (key) byContent.set(value.contentKey, key);
      // `null`, not the handle: returning it would call its `bytes()` thunk through
      // `JSON.stringify`, which is the materialisation this whole mechanism exists to avoid.
      return null;
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const key = keys[index];
      index += 1;
      const contentKey = typeof this?.contentKey === "string" ? this.contentKey : undefined;
      if (key && contentKey) byContent.set(contentKey, key);
      else if (key) into.set(value as ArrayBufferView, key);
      return null;
    }
    if (value instanceof Set) return null;
    return value;
  });
}

export class DocumentSnapshotStore {
  readonly #adapter: BinaryStorageAdapter;
  #writeQueue: Promise<void> = Promise.resolve();
  /**
   * Where each buffer already on disk was written.
   *
   * A layer's pixels are replaced rather than written in place, so the buffer's
   * own identity says whether it has changed since the last save. Without this
   * every autosave rewrote every layer of the document — a thirty-layer file
   * cost a quarter of a gigabyte and half a second of blocked main thread each
   * time, which is what the freezes during editing actually were.
   */
  readonly #binaryKeys = new WeakMap<ArrayBufferView, string>();
  /** The same answer for buffers that are rebuilt on every save and therefore have no stable
   *  identity to key on — see `SerializedBinary.contentKey`. */
  readonly #contentKeys = new Map<string, string>();
  /** Keys the pruning pass has confirmed are still on disk. */
  readonly #stored = new Set<string>();
  /**
   * What was written for each document last time, keyed by the revision it was written at.
   *
   * A document whose revision has not moved has not changed — that is what a revision is — so
   * there is nothing to serialise and nothing to compare. Without this, an autosave of an
   * untouched document still walked its whole state and materialised every layer's pixels just to
   * discover that every buffer was already on disk: 90 ms of the 110 ms a no-op save cost on a
   * six-layer 3000x3000 document (docs/master-plan.md §60.4).
   *
   * The keys are remembered too, so the pruning pass at the end of a save does not delete the
   * files of a document it skipped.
   */
  readonly #savedRevisions = new Map<string, { revision: number; snapshotKey: string; binaryKeys: readonly string[] }>();
  #nextBinaryId = 0;
  /** When storage was last enumerated — see the pruning pass for why this is on a slow clock. */
  #reconciledAt = 0;
  #onLoadError: (snapshotKey: string, error: unknown) => void = (key, error) => {
    console.warn(`[autosave] could not restore ${key}:`, error);
  };

  readonly #reconcileIntervalMs: number;

  /** `reconcileIntervalMs` is how rarely storage is enumerated (see the pruning pass). It is a
   *  parameter because a test cannot wait a minute to prove that a wiped storage is noticed. */
  constructor(adapter: BinaryStorageAdapter, options: { reconcileIntervalMs?: number } = {}) {
    this.#adapter = adapter;
    this.#reconcileIntervalMs = options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
  }

  saveSession(documents: readonly VravioDocument[]): Promise<void> {
    this.#writeQueue = this.#writeQueue.catch(() => undefined).then(() => this.#saveSessionNow(documents));
    return this.#writeQueue;
  }

  async loadSession(): Promise<readonly VravioDocument[]> {
    const bytes = await this.#adapter.get(SESSION_KEY);
    if (!bytes) return [];
    const manifest = JSON.parse(decoder.decode(bytes)) as SessionManifest;
    if (manifest.schemaVersion !== 1) throw new Error(`Unsupported session schema: ${String(manifest.schemaVersion)}`);

    // A document that cannot be read is skipped, not thrown. This is a scratch
    // copy of work the user still has in front of them; losing one of several
    // restored documents is a bad morning, and refusing to start at all because
    // one scratch file is missing is a worse one.
    const restored: VravioDocument[] = [];
    for (const entry of manifest.documents) {
      try {
        restored.push(await this.#loadDocument(entry.snapshotKey));
      } catch (error) {
        this.#onLoadError(entry.snapshotKey, error);
      }
    }
    return restored;
  }

  /** Where unreadable snapshots are reported. Defaults to the console. */
  onLoadError(handler: (snapshotKey: string, error: unknown) => void): void {
    this.#onLoadError = handler;
  }

  async clear(): Promise<void> {
    const keys = await this.#adapter.list("autosave/");
    await Promise.all(keys.map((key) => this.#adapter.remove(key)));
  }

  async #saveSessionNow(documents: readonly VravioDocument[]): Promise<void> {
    const entries: SessionEntry[] = [];
    const keep = new Set<string>([SESSION_KEY]);
    // Has storage been emptied under us? One `get` of the manifest answers it — a wipe takes
    // everything, so the manifest going missing while this store believes it wrote one is the
    // signal. This replaces re-listing the whole namespace on every save, which is the same
    // question asked in the most expensive possible way (master-plan §63).
    if (this.#stored.size > 0 && !(await this.#adapter.get(SESSION_KEY))) {
      this.#stored.clear();
      this.#contentKeys.clear();
      this.#savedRevisions.clear();
      this.#reconciledAt = 0;
    }
    for (const document of documents) {
      // The revision is deliberately not part of the path. Putting it there gave
      // every save a fresh prefix, which made rewriting everything and deleting
      // the previous copy unavoidable however little had changed.
      const prefix = `autosave/documents/${document.id}`;
      const snapshotKey = `${prefix}/document.json`;
      // Unchanged since the last successful save: keep what is on disk and touch nothing. The
      // `#stored` checks are what makes this safe — a file that was pruned, or never landed,
      // is not remembered as being there, so the document is written again rather than assumed.
      const saved = this.#savedRevisions.get(document.id);
      if (saved && saved.revision === document.revision && this.#stored.has(saved.snapshotKey) && saved.binaryKeys.every((key) => this.#stored.has(key))) {
        keep.add(saved.snapshotKey);
        for (const key of saved.binaryKeys) keep.add(key);
        entries.push({ id: document.id, revision: document.revision, snapshotKey: saved.snapshotKey });
        continue;
      }
      const { envelope, binaries } = serializeDocument(document);
      const binaryKeys: string[] = [];
      for (const binary of binaries) {
        const { contentKey } = binary;
        let key = contentKey ? this.#contentKeys.get(contentKey) : binary.view && this.#binaryKeys.get(binary.view);
        if (!key || !this.#stored.has(key)) {
          key ??= `${prefix}/binaries/${this.#nextBinaryId++}.bin`;
          // Only here are the bytes asked for: a chunk already on disk is never materialised.
          const view = binary.view ?? binary.bytes!();
          await this.#adapter.set(key, new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
          if (contentKey) this.#contentKeys.set(contentKey, key); else this.#binaryKeys.set(view, key);
          this.#stored.add(key);
        }
        binaryKeys.push(key);
        keep.add(key);
      }
      await this.#adapter.set(snapshotKey, encoder.encode(JSON.stringify({ ...envelope, binaryKeys })));
      this.#stored.add(snapshotKey);
      this.#savedRevisions.set(document.id, { revision: document.revision, snapshotKey, binaryKeys });
      keep.add(snapshotKey);
      entries.push({ id: document.id, revision: document.revision, snapshotKey });
    }
    const manifest: SessionManifest = { schemaVersion: 1, savedAt: Date.now(), documents: entries };
    await this.#adapter.set(SESSION_KEY, encoder.encode(JSON.stringify(manifest)));
    // Pruning normally works from what this store knows it wrote — enumerating storage is not free:
    // OPFS walks its directory an entry at a time, measured at ~10.7 s for the ~500 files a
    // six-layer document now occupies once layers are stored as chunks (master-plan §63). Doing
    // that on every autosave would trade a 34 MB write for a ten-second directory walk.
    for (const key of [...this.#stored]) {
      if (keep.has(key)) continue;
      await this.#adapter.remove(key);
      this.#stored.delete(key);
    }
    // Orphans — files from a previous run that nothing points at any more — need a real walk, and
    // that walk is expensive, so it happens once per session. Everything this session writes is
    // already tracked above, so there is nothing new for it to find afterwards.
    const now = Date.now();
    if (this.#reconciledAt !== 0 && now - this.#reconciledAt < this.#reconcileIntervalMs) return;
    this.#reconciledAt = now;
    const present = new Set(await this.#adapter.list("autosave/"));
    for (const key of present) {
      if (keep.has(key)) continue;
      await this.#adapter.remove(key);
      present.delete(key);
    }
    this.#stored.clear();
    for (const key of present) this.#stored.add(key);
  }

  async #loadDocument(snapshotKey: string): Promise<VravioDocument> {
    const bytes = await this.#adapter.get(snapshotKey);
    if (!bytes) throw new Error(`Missing document snapshot: ${snapshotKey}`);
    const envelope = JSON.parse(decoder.decode(bytes)) as SnapshotEnvelope;
    if (envelope.schemaVersion !== 1) throw new Error(`Unsupported document snapshot schema: ${String(envelope.schemaVersion)}`);
    const prefix = snapshotKey.slice(0, snapshotKey.lastIndexOf("/"));
    const binaries = await Promise.all(Array.from({ length: envelope.binaryCount }, async (_unused, index) => {
      // Snapshots written before binaries were reused numbered them by position.
      const key = envelope.binaryKeys?.[index] ?? `${prefix}/binary-${index}.bin`;
      const binary = await this.#adapter.get(key);
      if (!binary) throw new Error(`Missing document snapshot binary: ${index}`);
      this.#stored.add(key);
      return binary;
    }));
    const document = deserializeDocument(envelope, binaries);
    // Remember where the restored buffers came from, so the first save after a
    // reload does not rewrite the whole document it just read.
    if (envelope.binaryKeys) rememberRestoredBinaries(document, envelope.binaryKeys, this.#binaryKeys, this.#contentKeys);
    // Restored at exactly the revision the snapshot was written at, so the first autosave after a
    // reload has nothing to do either — it used to rewrite every document that was open.
    this.#stored.add(snapshotKey);
    this.#savedRevisions.set(document.id, { revision: document.revision, snapshotKey, binaryKeys: envelope.binaryKeys ?? [] });
    this.#nextBinaryId = Math.max(this.#nextBinaryId, ...(envelope.binaryKeys ?? []).map(binaryIdOf), 0) + 1;
    return document;
  }
}

