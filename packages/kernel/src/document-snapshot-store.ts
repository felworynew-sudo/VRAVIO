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
const SESSION_KEY = "autosave/session.v1.json";
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
function serializeDocument(document: VravioDocument): { envelope: SnapshotEnvelope; binaries: TypedArray[] } {
  const binaries: TypedArray[] = [];
  const state = JSON.parse(JSON.stringify(document.state, (_key, value: unknown) => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const view = value as TypedArray;
      const index = binaries.push(view) - 1;
      return { __vravio: "typed-array", index, arrayType: view.constructor.name };
    }
    if (value instanceof ArrayBuffer) {
      const index = binaries.push(new Uint8Array(value)) - 1;
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
    const marker = value as { __vravio: string; index?: number; arrayType?: string; values?: unknown[] };
    if (marker.__vravio === "set") return new Set(marker.values ?? []);
    if (marker.index === undefined) throw new Error("Invalid binary marker in document snapshot");
    const bytes = binaries[marker.index];
    if (!bytes) throw new Error(`Missing binary ${marker.index} in document snapshot`);
    const buffer = bytes.slice().buffer;
    if (marker.__vravio === "array-buffer") return buffer;
    const factory = marker.arrayType ? typedArrayFactories[marker.arrayType] : undefined;
    if (!factory) throw new Error(`Unsupported typed array: ${marker.arrayType ?? "unknown"}`);
    return factory(buffer);
  }) as unknown;
  return { ...envelope.document, state, assetRefs: new Set(envelope.document.assetRefs) } as VravioDocument;
}

const binaryIdOf = (key: string): number => {
  const match = /\/binaries\/(\d+)\.bin$/.exec(key);
  return match ? Number(match[1]) : -1;
};

/** Re-links restored buffers to the keys they were read from, in document order. */
function rememberRestoredBinaries(document: VravioDocument, keys: readonly string[], into: WeakMap<ArrayBufferView, string>): void {
  let index = 0;
  JSON.stringify(document.state, (_key, value: unknown) => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const key = keys[index];
      index += 1;
      if (key) into.set(value as ArrayBufferView, key);
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
  /** Keys the pruning pass has confirmed are still on disk. */
  readonly #stored = new Set<string>();
  #nextBinaryId = 0;
  #onLoadError: (snapshotKey: string, error: unknown) => void = (key, error) => {
    console.warn(`[autosave] could not restore ${key}:`, error);
  };

  constructor(adapter: BinaryStorageAdapter) { this.#adapter = adapter; }

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
    for (const document of documents) {
      // The revision is deliberately not part of the path. Putting it there gave
      // every save a fresh prefix, which made rewriting everything and deleting
      // the previous copy unavoidable however little had changed.
      const prefix = `autosave/documents/${document.id}`;
      const snapshotKey = `${prefix}/document.json`;
      const { envelope, binaries } = serializeDocument(document);
      const binaryKeys: string[] = [];
      for (const view of binaries) {
        let key = this.#binaryKeys.get(view);
        if (!key || !this.#stored.has(key)) {
          key ??= `${prefix}/binaries/${this.#nextBinaryId++}.bin`;
          await this.#adapter.set(key, new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
          this.#binaryKeys.set(view, key);
          this.#stored.add(key);
        }
        binaryKeys.push(key);
        keep.add(key);
      }
      await this.#adapter.set(snapshotKey, encoder.encode(JSON.stringify({ ...envelope, binaryKeys })));
      keep.add(snapshotKey);
      entries.push({ id: document.id, revision: document.revision, snapshotKey });
    }
    const manifest: SessionManifest = { schemaVersion: 1, savedAt: Date.now(), documents: entries };
    await this.#adapter.set(SESSION_KEY, encoder.encode(JSON.stringify(manifest)));
    for (const key of await this.#adapter.list("autosave/")) {
      if (keep.has(key)) continue;
      await this.#adapter.remove(key);
      this.#stored.delete(key);
    }
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
    if (envelope.binaryKeys) rememberRestoredBinaries(document, envelope.binaryKeys, this.#binaryKeys);
    this.#nextBinaryId = Math.max(this.#nextBinaryId, ...(envelope.binaryKeys ?? []).map(binaryIdOf), 0) + 1;
    return document;
  }
}

