import { describe, expect, it, vi } from "vitest";
import { AssetStore, CommandRegistry, DocumentStore, HistoryManager } from "./index";

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
});
