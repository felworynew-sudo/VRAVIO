import { describe, expect, it, vi } from "vitest";
import { AssetStore, AutosaveManager, CommandRegistry, DocumentSnapshotStore, DocumentStore, GPUContext, HistoryManager, KeymapManager, MemoryStorageAdapter, ModelConsentDeniedError, ModelStore, WorkerPool, type AssetId, type WorkerTaskClient } from "./index";
import type { KeyboardShortcutEvent } from "./keymap-manager";

describe("DocumentStore", () => {
  it("increments revisions without storing document state in a UI store", () => {
    const store = new DocumentStore();
    const document = store.create("raster", "Untitled", { value: 1 });
    const listener = vi.fn();
    const subscription = store.subscribe(listener);
    expect(store.update<{ value: number }>(document.id, (state) => { state.value = 2; })).toBe(1);
    expect(store.get<{ value: number }>(document.id)?.state.value).toBe(2);
    expect(document.dirty).toBe(true);
    expect(listener).toHaveBeenCalled();
    subscription.dispose();
  });

  it("tracks asset references, origin and provenance metadata as document revisions", () => {
    const assetId = "asset:test" as AssetId;
    const store = new DocumentStore();
    const document = store.create("raster", "Linked", {}, { assetRefs: [assetId], origin: { kind: "asset", assetId, rev: 0, name: "source.raw" } });
    expect(document.assetRefs.has(assetId)).toBe(true);
    expect(document.origin).toMatchObject({ kind: "asset", assetId, rev: 0 });
    expect(store.removeAssetRef(document.id, assetId)).toBe(true);
    expect(document.revision).toBe(1);
    expect(document.dirty).toBe(true);
  });
});

describe("HistoryManager", () => {
  it("executes, undoes and redoes reversible operations", async () => {
    let value = 0;
    const history = new HistoryManager();
    await history.execute({ label: "Increment", redo: () => { value += 1; }, undo: () => { value -= 1; } });
    expect(value).toBe(1);
    expect(await history.undo()).toBe(true);
    expect(value).toBe(0);
    expect(await history.redo()).toBe(true);
    expect(value).toBe(1);
  });

  it("evicts old operations by memory budget and releases their resources", async () => {
    const freed: number[] = [];
    const history = new HistoryManager({ limit: 20, memoryLimitBytes: 10 });
    for (let index = 0; index < 3; index += 1) await history.execute({ label: String(index), memoryEstimate: 6, redo() {}, undo() {}, free: () => { freed.push(index); } });
    expect(history.undoCount).toBe(1);
    expect(history.memoryBytes).toBe(6);
    expect(freed).toEqual([0, 1]);
  });

  it("rolls back a failed batch and records nothing", async () => {
    let value = 0;
    const history = new HistoryManager();
    await expect(history.executeBatch("Transaction", [
      { label: "first", redo: () => { value += 1; }, undo: () => { value -= 1; } },
      { label: "fail", redo: () => { throw new Error("stop"); }, undo() {} },
    ])).rejects.toThrow("stop");
    expect(value).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it("frees the redo branch when a new operation replaces it", async () => {
    const freed = vi.fn();
    const history = new HistoryManager();
    await history.execute({ label: "old", redo() {}, undo() {}, free: freed });
    await history.undo();
    await history.execute({ label: "new", redo() {}, undo() {} });
    expect(freed).toHaveBeenCalledOnce();
    expect(history.canRedo).toBe(false);
  });

  it("reports a timeline of applied and undone steps", async () => {
    const history = new HistoryManager();
    for (const label of ["one", "two", "three"]) await history.execute({ label, redo() {}, undo() {} });
    await history.undo();
    expect(history.position).toBe(2);
    expect(history.timeline().map((entry) => [entry.position, entry.label, entry.applied])).toEqual([
      [1, "one", true], [2, "two", true], [3, "three", false],
    ]);
  });

  it("jumps to any timeline position in both directions", async () => {
    let value = 0;
    const history = new HistoryManager();
    for (let index = 0; index < 4; index += 1) await history.execute({ label: `step ${index}`, redo: () => { value += 1; }, undo: () => { value -= 1; } });
    expect(await history.jumpTo(1)).toBe(true);
    expect(value).toBe(1);
    expect(await history.jumpTo(4)).toBe(true);
    expect(value).toBe(4);
    expect(await history.jumpTo(0)).toBe(true);
    expect(value).toBe(0);
    expect(await history.jumpTo(9)).toBe(false);
    expect(await history.jumpTo(-1)).toBe(false);
  });

  it("notifies subscribers when the timeline changes", async () => {
    const listener = vi.fn();
    const history = new HistoryManager();
    const subscription = history.subscribe(listener);
    await history.execute({ label: "step", redo() {}, undo() {} });
    await history.undo();
    await history.redo();
    expect(listener).toHaveBeenCalledTimes(3);
    subscription.dispose();
    await history.undo();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("CommandRegistry", () => {
  it("searches and executes enabled commands", async () => {
    const registry = new CommandRegistry();
    const execute = vi.fn();
    registry.register({ id: "file.save", label: "Save (Сохранить)", category: "File", execute });
    expect(registry.search("сохран")).toHaveLength(1);
    expect(await registry.execute("file.save", { activeDocumentId: "doc" })).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("AssetStore", () => {
  it("deduplicates identical bytes by SHA-256", async () => {
    const store = new AssetStore();
    const first = await store.put(new Uint8Array([1, 2, 3]), "image/png");
    const second = await store.put(new Uint8Array([1, 2, 3]), "image/png");
    expect(second.id).toBe(first.id);
    expect(store.size).toBe(1);
  });

  it("does not return an asset whose head moved past the matching revision", async () => {
    const store = new AssetStore();
    const original = await store.importAsset(new Uint8Array([1, 2, 3]), { kind: "image", mime: "image/png", name: "one.png" });
    await store.commitRevision(original, new Uint8Array([9, 9, 9]), "raster", "paint");

    const importedAgain = await store.importAsset(new Uint8Array([1, 2, 3]), { kind: "image", mime: "image/png", name: "two.png" });

    expect(importedAgain).not.toBe(original);
    expect([...await store.read(importedAgain) ?? []]).toEqual([1, 2, 3]);
  });

  it("does not deduplicate bytes across incompatible asset semantics", async () => {
    const store = new AssetStore();
    const image = await store.importAsset(new Uint8Array([1, 2, 3]), { kind: "image", mime: "image/png", name: "a.png", meta: { profile: "sRGB" } });
    const vector = await store.importAsset(new Uint8Array([1, 2, 3]), { kind: "vector", mime: "image/svg+xml", name: "a.svg", meta: { profile: "sRGB" } });
    const taggedImage = await store.importAsset(new Uint8Array([1, 2, 3]), { kind: "image", mime: "image/png", name: "b.png", meta: { profile: "Display P3" } });

    expect(new Set([image, vector, taggedImage]).size).toBe(3);
  });

  it("persists revision metadata and rolls the head back without deleting data", async () => {
    const adapter = new MemoryStorageAdapter();
    const store = new AssetStore(adapter);
    const id = await store.importAsset(new Uint8Array([10, 20]), { kind: "image", mime: "image/png", name: "source.png" });
    const revised = vi.fn();
    store.subscribe("revised", revised);
    expect(await store.commitRevision(id, new Uint8Array([30, 40]), "raster-env", "Paint stroke")).toBe(1);
    expect([...await store.read(id) ?? []]).toEqual([30, 40]);
    await store.rollback(id, 0);
    expect([...await store.read(id) ?? []]).toEqual([10, 20]);
    expect(revised).toHaveBeenLastCalledWith({ assetId: id, rev: 0, producedBy: "undo" });

    const restored = new AssetStore(adapter);
    await restored.initialize();
    expect(restored.get(id)?.revisions).toHaveLength(2);
    expect(restored.get(id)?.head).toBe(0);
  });

  it("protects referenced assets from deletion", async () => {
    const store = new AssetStore();
    const id = await store.importAsset(new Uint8Array([1]), { kind: "binary", name: "sample.bin" });
    expect(await store.delete(id)).toBe(false);
    expect(await store.release(id)).toBe(0);
    expect(await store.delete(id)).toBe(true);
    expect(store.has(id)).toBe(false);
  });
});

describe("WorkerPool", () => {
  it("limits concurrency and drains queued work", async () => {
    let active = 0, maximumActive = 0;
    const client: WorkerTaskClient<number, number> = {
      async run(value) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return value * 2;
      },
      dispose() {},
    };
    const pool = new WorkerPool(() => client, 2);
    await expect(Promise.all([pool.run(1), pool.run(2), pool.run(3), pool.run(4)])).resolves.toEqual([2, 4, 6, 8]);
    expect(maximumActive).toBe(2);
    expect(pool.activeCount).toBe(0);
    pool.dispose();
  });

  it("cancels queued work without starting it", async () => {
    let release!: () => void, runs = 0;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const pool = new WorkerPool<number, number>(() => ({
      async run(value) { runs += 1; await wait; return value; },
      dispose() {},
    }), 1);
    const first = pool.run(1);
    const controller = new AbortController();
    const second = pool.run(2, { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    release();
    await expect(first).resolves.toBe(1);
    expect(runs).toBe(1);
    pool.dispose();
  });
});

describe("KeymapManager", () => {
  it("uses physical key codes independently of the active keyboard layout", () => {
    const keymap = new KeymapManager();
    keymap.bind("tool.brush", "B");
    keymap.bind("edit.transform", "Mod+T");
    expect(keymap.resolve({ code: "KeyB", key: "и", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe("tool.brush");
    expect(keymap.resolve({ code: "KeyT", key: "е", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe("edit.transform");
  });

  it("normalizes shifted plus and reports shortcut conflicts", () => {
    const keymap = new KeymapManager();
    keymap.bind("view.zoomIn", "Mod++");
    keymap.bind("view.otherZoom", "Ctrl+Plus");
    expect(keymap.resolve({ code: "Equal", key: "+", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe("view.otherZoom");
    expect(keymap.conflicts("Mod++").map((binding) => binding.commandId)).toEqual(["view.zoomIn", "view.otherZoom"]);
  });

  it("notifies subscribers on bind, rebind and unbind, and stops after dispose", () => {
    const keymap = new KeymapManager();
    const changes = vi.fn();
    const subscription = keymap.subscribe(changes);
    keymap.bind("tool.brush", "B");
    keymap.bind("tool.brush", "Shift+B");
    expect(keymap.unbind("tool.brush")).toBe(true);
    expect(changes).toHaveBeenCalledTimes(3);
    subscription.dispose();
    keymap.bind("tool.eraser", "E");
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("falls back to a bare-letter binding for Shift+letter, but never across Ctrl or Alt", () => {
    const keymap = new KeymapManager();
    keymap.bind("tool.marquee", "M", "raster");
    keymap.bind("edit.redo", "Mod+Shift+Z");
    expect(keymap.resolve({ code: "KeyM", key: "M", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true }, ["raster"])).toBe("tool.marquee");
    expect(keymap.resolve({ code: "KeyM", key: "M", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true }, ["global"])).toBeNull();
    expect(keymap.resolve({ code: "KeyM", key: "M", ctrlKey: false, metaKey: false, altKey: true, shiftKey: true }, ["raster"])).toBeNull();
    expect(keymap.resolve({ code: "KeyZ", key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe("edit.redo");
  });

  it("resolves the bare-letter fallback for a DOM-Event-shaped object, not just a plain object", () => {
    // A real DOM Event's fields are non-enumerable accessors on the prototype, so a naive
    // `{ ...event }` inside resolve() would silently drop every one of them — a plain-object
    // literal wouldn't catch that, since its properties are already own and enumerable.
    const proto = { get code() { return "KeyM"; }, get key() { return "M"; }, get ctrlKey() { return false; }, get metaKey() { return false; }, get altKey() { return false; }, get shiftKey() { return true; } };
    const event = Object.create(proto) as KeyboardShortcutEvent;
    const keymap = new KeymapManager();
    keymap.bind("tool.marquee", "M", "raster");
    expect(keymap.resolve(event, ["raster"])).toBe("tool.marquee");
  });
});

describe("GPUContext", () => {
  it("selects the strongest available backend and degrades deterministically", async () => {
    const context = new GPUContext([
      { backend: "webgpu", available: () => false },
      { backend: "webgl2", available: () => true },
      { backend: "wasm-simd", available: () => true },
      { backend: "wasm", available: () => true },
    ]);
    const changes = vi.fn();
    context.subscribe(changes);
    await expect(context.initialize()).resolves.toBe("webgl2");
    expect(context.available).toEqual(["webgl2", "wasm-simd", "wasm", "cpu"]);
    expect(context.degrade("context-lost")).toBe("wasm-simd");
    expect(changes).toHaveBeenLastCalledWith({ previous: "webgl2", current: "wasm-simd", reason: "context-lost" });
  });

  it("falls back to CPU when capability probes fail", async () => {
    const context = new GPUContext([{ backend: "webgpu", available: () => { throw new Error("driver"); } }]);
    await expect(context.initialize()).resolves.toBe("cpu");
    expect(context.degrade("already-lowest")).toBe("cpu");
  });
});

describe("DocumentSnapshotStore", () => {
  it("stores typed arrays as separate binary entries and restores Sets", async () => {
    const adapter = new MemoryStorageAdapter();
    const snapshots = new DocumentSnapshotStore(adapter);
    const documents = new DocumentStore();
    const assetId = "asset:pixels" as AssetId;
    const document = documents.create("raster", "Recovered", { pixels: new Uint8ClampedArray([1, 2, 3, 255]), mask: new Uint8Array([255]), tags: new Set(["draft"]) }, { assetRefs: [assetId] });
    documents.update<typeof document.state>(document.id, (state) => { state.pixels[0] = 9; });
    await snapshots.saveSession(documents.list());
    expect((await adapter.list("autosave/")).some((key) => /\/binaries\/\d+\.bin$/.test(key))).toBe(true);

    const [restored] = await snapshots.loadSession();
    const state = restored?.state as typeof document.state;
    expect(state.pixels).toBeInstanceOf(Uint8ClampedArray);
    expect([...state.pixels]).toEqual([9, 2, 3, 255]);
    expect(state.mask).toBeInstanceOf(Uint8Array);
    expect(state.tags).toBeInstanceOf(Set);
    expect(restored?.assetRefs.has(assetId)).toBe(true);
  });

  it("rewrites only the buffers that changed", async () => {
    const writes: string[] = [];
    const inner = new MemoryStorageAdapter();
    const adapter = {
      get: (key: string) => inner.get(key),
      set: (key: string, value: Uint8Array) => { writes.push(key); return inner.set(key, value); },
      remove: (key: string) => inner.remove(key),
      list: (prefix?: string) => inner.list(prefix),
      clear: () => inner.clear(),
    };
    const snapshots = new DocumentSnapshotStore(adapter);
    const documents = new DocumentStore();
    const document = documents.create("raster", "Big", {
      a: new Uint8ClampedArray(1024), b: new Uint8ClampedArray(1024), c: new Uint8ClampedArray(1024),
    });

    await snapshots.saveSession(documents.list());
    const first = writes.filter((key) => key.includes("/binaries/")).length;
    writes.length = 0;

    // One layer edited, the way every edit does it: a fresh buffer in place of
    // the old one. The other two are the same objects they were.
    documents.update<{ a: Uint8ClampedArray }>(document.id, (state) => { state.a = new Uint8ClampedArray(1024).fill(7); });
    await snapshots.saveSession(documents.list());

    expect(first).toBe(3);
    // Rewriting all three was a quarter of a gigabyte per save on a real
    // document, and it happened after every edit.
    expect(writes.filter((key) => key.includes("/binaries/")).length).toBe(1);
  });

  it("does not rewrite a buffer that is rebuilt on every save but says what its content is called", async () => {
    // The regression this exists for (docs/master-plan.md §60): a tiled layer materialises a
    // *fresh* flat buffer every time it is serialised, so "has this changed?" answered from the
    // buffer's identity always said yes — every autosave rewrote every layer of every open
    // document (61.8 MB per save, measured on a six-layer 3000x3000 file with nothing edited).
    // The tests above all used plain buffers, which is exactly why nothing caught it. This one
    // states the contract instead of the class: an owner that rebuilds its buffer names the
    // content next to it, and the store trusts the name.
    const writes: string[] = [];
    const inner = new MemoryStorageAdapter();
    const adapter = {
      get: (key: string) => inner.get(key),
      set: (key: string, value: Uint8Array) => { writes.push(key); return inner.set(key, value); },
      remove: (key: string) => inner.remove(key),
      list: (prefix?: string) => inner.list(prefix),
      clear: () => inner.clear(),
    };
    const snapshots = new DocumentSnapshotStore(adapter);
    const documents = new DocumentStore();
    /** A stand-in for `TileStore`: a fresh buffer on every serialisation, plus a content name. */
    class Rebuilt {
      constructor(readonly bytes: readonly number[], public contentKey: string) {}
      toJSON() { return { contentKey: this.contentKey, pixels: new Uint8ClampedArray(this.bytes) }; }
    }
    const tiles = new Rebuilt([1, 2, 3, 4], "t1");
    const document = documents.create("raster", "Tiled", { tiles });

    await snapshots.saveSession(documents.list());
    const first = writes.filter((key) => key.includes("/binaries/")).length;
    writes.length = 0;

    // Nothing edited: a new buffer comes out of `toJSON`, but it is the same content.
    documents.update<{ tiles: Rebuilt }>(document.id, (state) => { state.tiles = state.tiles; });
    await snapshots.saveSession(documents.list());
    const unchangedWrites = writes.filter((key) => key.includes("/binaries/")).length;
    writes.length = 0;

    // Edited: a new name, so it is written again.
    documents.update<{ tiles: Rebuilt }>(document.id, (state) => { state.tiles = new Rebuilt([9, 9, 9, 9], "t2"); });
    await snapshots.saveSession(documents.list());

    expect(first).toBe(1);
    expect(unchangedWrites).toBe(0);
    expect(writes.filter((key) => key.includes("/binaries/")).length).toBe(1);
  });

  it("does not serialise a document whose revision has not moved", async () => {
    // §60.4: skipping the *write* still left the walk — every layer's pixels materialised just to
    // find out nothing had to be written. A revision that has not moved means nothing changed,
    // which is cheaper to ask than to prove.
    let serialisations = 0;
    const adapter = new MemoryStorageAdapter();
    const snapshots = new DocumentSnapshotStore(adapter);
    const documents = new DocumentStore();
    class Counted {
      constructor(public bytes: Uint8ClampedArray) {}
      toJSON() { serialisations += 1; return { contentKey: `c${this.bytes[0]}`, pixels: this.bytes.slice() }; }
    }
    const document = documents.create("raster", "Counted", { tiles: new Counted(new Uint8ClampedArray([1, 2, 3, 4])) });

    await snapshots.saveSession(documents.list());
    const afterFirst = serialisations;
    await snapshots.saveSession(documents.list());
    await snapshots.saveSession(documents.list());
    const afterIdle = serialisations;

    documents.update<{ tiles: Counted }>(document.id, (state) => { state.tiles = new Counted(new Uint8ClampedArray([9, 9, 9, 9])); });
    await snapshots.saveSession(documents.list());

    expect(afterFirst).toBe(1);
    // Two saves with nothing touched did not read the document's pixels at all.
    expect(afterIdle).toBe(1);
    expect(serialisations).toBe(2);
  });

  it("writes a document again when its files have been pruned from under it", async () => {
    // The revision shortcut must not trust itself blindly: a cleared storage has to be noticed.
    const inner = new MemoryStorageAdapter();
    const snapshots = new DocumentSnapshotStore(inner);
    const documents = new DocumentStore();
    documents.create("raster", "Doc", { pixels: new Uint8ClampedArray([1, 2, 3, 4]) });

    await snapshots.saveSession(documents.list());
    await inner.clear();
    // The save during which storage vanished cannot know yet; the one after it must, because the
    // pruning pass re-grounds the store's picture of what is on disk against what really is.
    await snapshots.saveSession(documents.list());
    await snapshots.saveSession(documents.list());

    const keys = await inner.list("autosave/");
    expect(keys.some((key) => key.endsWith("/document.json"))).toBe(true);
    expect(keys.some((key) => key.includes("/binaries/"))).toBe(true);
    // And it really restores, which is the only thing the user cares about.
    expect((await snapshots.loadSession()).length).toBe(1);
  });

  it("does not rewrite a document it has just restored", async () => {
    const writes: string[] = [];
    const inner = new MemoryStorageAdapter();
    const adapter = {
      get: (key: string) => inner.get(key),
      set: (key: string, value: Uint8Array) => { writes.push(key); return inner.set(key, value); },
      remove: (key: string) => inner.remove(key),
      list: (prefix?: string) => inner.list(prefix),
      clear: () => inner.clear(),
    };
    const snapshots = new DocumentSnapshotStore(adapter);
    const documents = new DocumentStore();
    documents.create("raster", "Big", { a: new Uint8ClampedArray(512), b: new Uint8ClampedArray(512) });
    await snapshots.saveSession(documents.list());

    const restored = await snapshots.loadSession();
    writes.length = 0;
    await snapshots.saveSession(restored);

    expect(writes.filter((key) => key.includes("/binaries/"))).toEqual([]);
  });

  it("keeps a document's binaries at one path instead of one per revision", async () => {
    const adapter = new MemoryStorageAdapter();
    const snapshots = new DocumentSnapshotStore(adapter);
    const documents = new DocumentStore();
    const document = documents.create("raster", "Big", { a: new Uint8ClampedArray(256) });

    await snapshots.saveSession(documents.list());
    documents.update<{ a: Uint8ClampedArray }>(document.id, (state) => { state.a = new Uint8ClampedArray(256).fill(1); });
    await snapshots.saveSession(documents.list());

    // Keying the path by revision meant every save landed in a new directory and
    // the previous one had to be deleted, so nothing could ever be reused.
    const binaries = (await adapter.list("autosave/")).filter((key) => key.includes("/binaries/"));
    expect(binaries).toHaveLength(1);
    // The replaced buffer's key is collected, and what comes back is the edit.
    const restored = (await snapshots.loadSession())[0]!.state as { a: Uint8ClampedArray };
    expect(restored.a[0]).toBe(1);
  });

  it("skips a document whose binaries have gone missing", async () => {
    const adapter = new MemoryStorageAdapter();
    const snapshots = new DocumentSnapshotStore(adapter);
    const documents = new DocumentStore();
    documents.create("raster", "Whole", { a: new Uint8ClampedArray([1, 2, 3, 4]) });
    documents.create("raster", "Broken", { a: new Uint8ClampedArray([5, 6, 7, 8]) });
    await snapshots.saveSession(documents.list());

    // One scratch binary disappears — a partial write, a cleared origin, a bug.
    const binaries = (await adapter.list("autosave/")).filter((key) => key.includes("/binaries/"));
    await adapter.remove(binaries[1]!);

    const reported: string[] = [];
    const reader = new DocumentSnapshotStore(adapter);
    reader.onLoadError((key) => reported.push(key));
    const restored = await reader.loadSession();

    // Refusing to start at all because one scratch file is missing is worse
    // than restoring the documents that are still readable.
    expect(restored).toHaveLength(1);
    expect(reported).toHaveLength(1);
  });

  it("restores a complete document session through AutosaveManager", async () => {
    const adapter = new MemoryStorageAdapter();
    const sourceDocuments = new DocumentStore();
    const source = sourceDocuments.create("vector", "Session", { nodes: [1, 2] });
    const writer = new AutosaveManager(sourceDocuments, new DocumentSnapshotStore(adapter), { delayMs: 1 });
    await writer.flush();

    const targetDocuments = new DocumentStore();
    const reader = new AutosaveManager(targetDocuments, new DocumentSnapshotStore(adapter));
    const restored = await reader.restore();
    expect(restored.map((document) => document.id)).toEqual([source.id]);
    expect(targetDocuments.get<{ nodes: number[] }>(source.id)?.state.nodes).toEqual([1, 2]);
  });
});

describe("ModelStore", () => {
  const spec = {
    id: "rmbg", url: "https://example.test/rmbg.onnx", sizeBytes: 40 * 1024 * 1024,
    inputShape: [1, 3, 1024, 1024], tile: { size: 1024, overlap: 32 },
    licence: "Non-commercial", commercialUse: false,
  };

  const memoryCache = () => {
    const entries = new Map<string, ArrayBuffer>();
    return {
      entries,
      async match(key: string) { const value = entries.get(key); return value ? new Response(value) : undefined; },
      async put(key: string, response: Response) { entries.set(key, await response.arrayBuffer()); },
      async delete(key: string) { return entries.delete(key); },
      async keys() { return [...entries.keys()]; },
    };
  };

  const streamingResponse = (bytes: number, chunkSize = 8) => {
    let sent = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= bytes) { controller.close(); return; }
        const size = Math.min(chunkSize, bytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(7));
      },
    }), { headers: { "content-length": String(bytes) } });
  };

  it("asks before downloading a large model and honours a refusal", async () => {
    const store = new ModelStore({ fetch: async () => streamingResponse(32), consentThresholdBytes: 1 });
    await expect(store.load(spec, { onConsent: () => false })).rejects.toBeInstanceOf(ModelConsentDeniedError);
  });

  it("reports progress that ends at the full size", async () => {
    const store = new ModelStore({ fetch: async () => streamingResponse(32, 8), consentThresholdBytes: Number.POSITIVE_INFINITY });
    const seen: number[] = [];
    const buffer = await store.load(spec, { onProgress: (progress) => seen.push(progress.receivedBytes) });
    expect(buffer.byteLength).toBe(32);
    expect(seen).toEqual([8, 16, 24, 32]);
  });

  it("serves a second load from the cache without fetching again", async () => {
    const cache = memoryCache();
    let fetches = 0;
    const store = new ModelStore({ cache, consentThresholdBytes: Number.POSITIVE_INFINITY, fetch: async () => { fetches += 1; return streamingResponse(16); } });
    await store.load(spec);
    expect(await store.isCached(spec)).toBe(true);
    const second = await store.load(spec);
    expect(fetches).toBe(1);
    expect(second.byteLength).toBe(16);
    expect(await store.evict(spec)).toBe(true);
    expect(await store.isCached(spec)).toBe(false);
  });

  it("picks up a cache attached after construction", async () => {
    // apps/web/src/kernel.ts builds the store before `caches.open` (async)
    // resolves, so a store with no cache yet must not be stuck without one
    // forever — `setCache` is how it gets attached once the promise settles.
    const cache = memoryCache();
    let fetches = 0;
    const store = new ModelStore({ consentThresholdBytes: Number.POSITIVE_INFINITY, fetch: async () => { fetches += 1; return streamingResponse(16); } });
    await store.load(spec);
    expect(await store.isCached(spec)).toBe(false);
    store.setCache(cache);
    expect(await store.isCached(spec)).toBe(false);
    await store.load(spec);
    expect(fetches).toBe(2);
    expect(await store.isCached(spec)).toBe(true);
    await store.load(spec);
    expect(fetches).toBe(2);
  });

  it("shares one download between concurrent callers", async () => {
    let fetches = 0;
    const store = new ModelStore({ consentThresholdBytes: Number.POSITIVE_INFINITY, fetch: async () => { fetches += 1; return streamingResponse(16); } });
    const [first, second] = await Promise.all([store.load(spec), store.load(spec)]);
    expect(fetches).toBe(1);
    expect(first.byteLength).toBe(second.byteLength);
  });

  it("cancels a download in progress", async () => {
    const controller = new AbortController();
    const store = new ModelStore({
      consentThresholdBytes: Number.POSITIVE_INFINITY,
      fetch: async () => streamingResponse(4096, 8),
    });
    const pending = store.load(spec, { signal: controller.signal, onProgress: () => controller.abort() });
    await expect(pending).rejects.toThrow(/cancelled/i);
  });

  it("surfaces a failed download instead of caching an error page", async () => {
    const cache = memoryCache();
    const store = new ModelStore({ cache, consentThresholdBytes: Number.POSITIVE_INFINITY, fetch: async () => new Response("nope", { status: 404 }) });
    await expect(store.load(spec)).rejects.toThrow(/404/);
    expect(await store.isCached(spec)).toBe(false);
  });
});
