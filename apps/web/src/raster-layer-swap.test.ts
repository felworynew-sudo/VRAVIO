import { appendLayer, createRasterDocument, createRasterLayer, isRasterDocumentState, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import { DocumentSnapshotStore, DocumentStore, MemoryStorageAdapter, type BinaryStorageAdapter } from "@vravio/kernel";
import { describe, expect, it } from "vitest";
import { LayerSwapManager } from "./raster-layer-swap";

/**
 * `LayerSwapManager` is docs/master-plan.md §37.3 item 6's actual eviction/restore orchestration.
 * `MemoryStorageAdapter` stands in for the real `ResilientStorageAdapter` throughout — it has no
 * `.backing` property, so `#sweepNow`'s duck-typed "skip when memory-backed" policy check treats it
 * as worth evicting to (see that method's own doc comment), which is exactly what lets these tests
 * exercise the real evict/restore round trip without a browser's OPFS/IndexedDB to probe.
 */

function fixture(width: number, height: number, seed: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (seed + i) % 256; pixels[i + 1] = (seed * 3 + i) % 256; pixels[i + 2] = (seed * 7 + i) % 256; pixels[i + 3] = 255;
  }
  return pixels;
}

function sceneWithHiddenLayer(): { documents: DocumentStore; documentId: string; hiddenLayerId: string; hiddenPixels: Uint8ClampedArray } {
  const documents = new DocumentStore();
  const state = createRasterDocument(40, 30);
  const active = state.layers[0]!;
  setLayerPixels(active, fixture(40, 30, 1), 40, 30);
  const hidden = createRasterLayer(40, 30, "Hidden");
  const hiddenPixels = fixture(40, 30, 99);
  setLayerPixels(hidden, hiddenPixels, 40, 30);
  hidden.visible = false;
  appendLayer(state, hidden);
  state.activeLayerId = active.id;
  const document = documents.create<RasterDocumentState>("raster", "Test", state);
  return { documents, documentId: document.id, hiddenLayerId: hidden.id, hiddenPixels };
}

describe("LayerSwapManager", () => {
  it("evicts a hidden, inactive pixel layer on a flush, freeing its tiles", async () => {
    const { documents, documentId, hiddenLayerId } = sceneWithHiddenLayer();
    const manager = new LayerSwapManager(documents, new MemoryStorageAdapter());
    await manager.flush();

    const layer = documents.get<RasterDocumentState>(documentId)!.state.layers.find((item) => item.id === hiddenLayerId)!;
    expect(layer.tiles.evicted).toBe(true);
  });

  it("restores byte-identical pixels and clears the evicted flag", async () => {
    const { documents, documentId, hiddenLayerId, hiddenPixels } = sceneWithHiddenLayer();
    const manager = new LayerSwapManager(documents, new MemoryStorageAdapter());
    await manager.flush();
    const layer = documents.get<RasterDocumentState>(documentId)!.state.layers.find((item) => item.id === hiddenLayerId)!;
    expect(layer.tiles.evicted).toBe(true);

    await manager.restore(documentId, layer);

    expect(layer.tiles.evicted).toBe(false);
    expect([...layer.tiles.toPixels()]).toEqual([...hiddenPixels]);
  });

  it("restore() is a no-op for a layer that was never evicted", async () => {
    const { documents, documentId } = sceneWithHiddenLayer();
    const manager = new LayerSwapManager(documents, new MemoryStorageAdapter());
    const active = documents.get<RasterDocumentState>(documentId)!.state.layers[0]!;
    const before = active.tiles;

    await manager.restore(documentId, active);

    expect(active.tiles).toBe(before); // untouched — never replaced, never even read
  });

  it("never evicts the active layer, even if it is also hidden", async () => {
    const { documents, documentId, hiddenLayerId } = sceneWithHiddenLayer();
    const state = documents.get<RasterDocumentState>(documentId)!.state;
    state.activeLayerId = hiddenLayerId; // now hidden AND active
    const manager = new LayerSwapManager(documents, new MemoryStorageAdapter());

    await manager.flush();

    expect(state.layers.find((item) => item.id === hiddenLayerId)!.tiles.evicted).toBe(false);
  });

  it("never evicts a visible layer", async () => {
    const { documents, documentId } = sceneWithHiddenLayer();
    const manager = new LayerSwapManager(documents, new MemoryStorageAdapter());

    await manager.flush();

    const active = documents.get<RasterDocumentState>(documentId)!.state.layers[0]!;
    expect(active.tiles.evicted).toBe(false);
  });

  it("does nothing at all when storage reports a memory backing", async () => {
    const { documents, documentId, hiddenLayerId } = sceneWithHiddenLayer();
    const memoryBacked: BinaryStorageAdapter & { backing: string } = Object.assign(new MemoryStorageAdapter(), { backing: "memory" });
    const manager = new LayerSwapManager(documents, memoryBacked);

    await manager.flush();

    const layer = documents.get<RasterDocumentState>(documentId)!.state.layers.find((item) => item.id === hiddenLayerId)!;
    expect(layer.tiles.evicted).toBe(false);
  });

  it("does evict when storage reports a real (non-memory) backing", async () => {
    const { documents, documentId, hiddenLayerId } = sceneWithHiddenLayer();
    const indexedDbLike: BinaryStorageAdapter & { backing: string } = Object.assign(new MemoryStorageAdapter(), { backing: "indexeddb" });
    const manager = new LayerSwapManager(documents, indexedDbLike);

    await manager.flush();

    const layer = documents.get<RasterDocumentState>(documentId)!.state.layers.find((item) => item.id === hiddenLayerId)!;
    expect(layer.tiles.evicted).toBe(true);
  });

  it("does not evict a non-pixel layer kind", async () => {
    const documents = new DocumentStore();
    const state = createRasterDocument(20, 20);
    const group = createRasterLayer(20, 20, "Group-shaped");
    group.kind = "text";
    group.visible = false;
    appendLayer(state, group);
    const document = documents.create<RasterDocumentState>("raster", "Test", state);
    const manager = new LayerSwapManager(documents, new MemoryStorageAdapter());

    await manager.flush();

    expect(document.state.layers.find((item) => item.id === group.id)!.tiles.evicted).toBe(false);
  });

  /**
   * Found live, in the browser, not by reasoning about it: `DocumentSnapshotStore`'s autosave calls
   * `JSON.stringify` on the whole document on its own idle timer, which invokes every `TileStore`'s
   * `toJSON()` unconditionally — including an evicted layer's. Before `toJSON()` was special-cased
   * to describe "evicted" instead of throwing, the very first autosave after any eviction crashed
   * with an unhandled `EvictedTileStoreError` rejection. This is the regression test for that.
   */
  it("autosave (DocumentSnapshotStore) does not crash on a document with an evicted layer, and a reload keeps it evicted", async () => {
    const { documents, documentId, hiddenLayerId, hiddenPixels } = sceneWithHiddenLayer();
    // The layer swap's own storage — separate from the session/autosave storage below, exactly as
    // `kernel.ts` wires two independent `ResilientStorageAdapter` instances in production. Reused
    // for `reloadedSwap` further down because that is where the evicted layer's real bytes actually
    // live; the autosave snapshot itself never duplicates them (that is the whole point of
    // `toJSON()`'s `{ evicted: true }` shape).
    const swapStorage = new MemoryStorageAdapter();
    const swap = new LayerSwapManager(documents, swapStorage);
    await swap.flush();
    const evictedLayer = documents.get<RasterDocumentState>(documentId)!.state.layers.find((item) => item.id === hiddenLayerId)!;
    expect(evictedLayer.tiles.evicted).toBe(true);

    const sessionStorage = new MemoryStorageAdapter();
    const writer = new DocumentSnapshotStore(sessionStorage);
    await expect(writer.saveSession(documents.list())).resolves.not.toThrow();

    const reloadedDocuments = new DocumentStore();
    const reader = new DocumentSnapshotStore(sessionStorage);
    const restored = await reader.loadSession();
    reloadedDocuments.restore(restored[0]!);
    const reloadedState = reloadedDocuments.get<RasterDocumentState>(documentId)!.state;
    // `document-snapshot-store.ts` is kind-agnostic — it hands back plain JSON shapes, not real
    // `TileStore` instances. `isRasterDocumentState` is the type guard the real app already calls
    // on every restored document before using it, and its own side effect (`migrateRasterDocumentState`)
    // is what turns each layer's plain `{width,height,channels,pixels|evicted}` object back into an
    // actual `TileStore` — skipping this call here would test a state shape the app itself never
    // hands to `LayerSwapManager.restore()`.
    expect(isRasterDocumentState(reloadedState)).toBe(true);
    const reloadedLayer = reloadedState.layers.find((item) => item.id === hiddenLayerId)!;
    expect(reloadedLayer.tiles.evicted).toBe(true);

    // And restoring it after reload still works — the deterministic (documentId, layerId,
    // pixelsRevision) key survived the round trip even though the layer is a brand new object.
    const reloadedSwap = new LayerSwapManager(reloadedDocuments, swapStorage);
    await reloadedSwap.restore(documentId, reloadedLayer);
    expect(reloadedLayer.tiles.evicted).toBe(false);
    expect([...reloadedLayer.tiles.toPixels()]).toEqual([...hiddenPixels]);
  });

  it("schedule() debounces: a flush right after scheduling still evicts once settled", async () => {
    const { documents, documentId, hiddenLayerId } = sceneWithHiddenLayer();
    const manager = new LayerSwapManager(documents, new MemoryStorageAdapter(), { delayMs: 5 });
    manager.schedule();
    await manager.flush(); // cancels the pending timer and sweeps immediately instead

    const layer = documents.get<RasterDocumentState>(documentId)!.state.layers.find((item) => item.id === hiddenLayerId)!;
    expect(layer.tiles.evicted).toBe(true);
  });
});
