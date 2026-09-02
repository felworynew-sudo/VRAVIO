import type { BinaryStorageAdapter } from "./storage-adapter";
import type { VravioDocument } from "./types";

interface SessionEntry { readonly id: string; readonly revision: number; readonly snapshotKey: string }
interface SessionManifest { readonly schemaVersion: 1; readonly savedAt: number; readonly documents: readonly SessionEntry[] }
interface SnapshotEnvelope {
  readonly schemaVersion: 1;
  readonly document: Omit<VravioDocument, "state" | "assetRefs"> & { assetRefs: string[]; state: unknown };
  readonly binaryCount: number;
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

function serializeDocument(document: VravioDocument): { envelope: SnapshotEnvelope; binaries: Uint8Array[] } {
  const binaries: Uint8Array[] = [];
  const state = JSON.parse(JSON.stringify(document.state, (_key, value: unknown) => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const view = value as TypedArray;
      const index = binaries.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()) - 1;
      return { __vravio: "typed-array", index, arrayType: view.constructor.name };
    }
    if (value instanceof ArrayBuffer) {
      const index = binaries.push(new Uint8Array(value).slice()) - 1;
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

export class DocumentSnapshotStore {
  readonly #adapter: BinaryStorageAdapter;
  #writeQueue: Promise<void> = Promise.resolve();

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
    return Promise.all(manifest.documents.map((entry) => this.#loadDocument(entry.snapshotKey)));
  }

  async clear(): Promise<void> {
    const keys = await this.#adapter.list("autosave/");
    await Promise.all(keys.map((key) => this.#adapter.remove(key)));
  }

  async #saveSessionNow(documents: readonly VravioDocument[]): Promise<void> {
    const entries: SessionEntry[] = [];
    const keep = new Set<string>([SESSION_KEY]);
    for (const document of documents) {
      const prefix = `autosave/documents/${document.id}/${document.revision}`;
      const snapshotKey = `${prefix}/document.json`;
      const { envelope, binaries } = serializeDocument(document);
      for (let index = 0; index < binaries.length; index += 1) {
        const key = `${prefix}/binary-${index}.bin`;
        await this.#adapter.set(key, binaries[index]!);
        keep.add(key);
      }
      await this.#adapter.set(snapshotKey, encoder.encode(JSON.stringify(envelope)));
      keep.add(snapshotKey);
      entries.push({ id: document.id, revision: document.revision, snapshotKey });
    }
    const manifest: SessionManifest = { schemaVersion: 1, savedAt: Date.now(), documents: entries };
    await this.#adapter.set(SESSION_KEY, encoder.encode(JSON.stringify(manifest)));
    for (const key of await this.#adapter.list("autosave/")) if (!keep.has(key)) await this.#adapter.remove(key);
  }

  async #loadDocument(snapshotKey: string): Promise<VravioDocument> {
    const bytes = await this.#adapter.get(snapshotKey);
    if (!bytes) throw new Error(`Missing document snapshot: ${snapshotKey}`);
    const envelope = JSON.parse(decoder.decode(bytes)) as SnapshotEnvelope;
    if (envelope.schemaVersion !== 1) throw new Error(`Unsupported document snapshot schema: ${String(envelope.schemaVersion)}`);
    const prefix = snapshotKey.slice(0, snapshotKey.lastIndexOf("/"));
    const binaries = await Promise.all(Array.from({ length: envelope.binaryCount }, async (_unused, index) => {
      const binary = await this.#adapter.get(`${prefix}/binary-${index}.bin`);
      if (!binary) throw new Error(`Missing document snapshot binary: ${index}`);
      return binary;
    }));
    return deserializeDocument(envelope, binaries);
  }
}

