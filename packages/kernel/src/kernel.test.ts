import { describe, expect, it, vi } from "vitest";
import { AssetStore, CommandRegistry, DocumentStore, HistoryManager, KeymapManager, MemoryStorageAdapter, WorkerPool, type AssetId, type WorkerTaskClient } from "./index";

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
});
