import { describe, expect, it, vi } from "vitest";
import { AssetStore, EventBus, HistoryManager, MemoryStorageAdapter, createBufferRevisionOperation, type AssetId, type ReversibleOperation } from "./index";

describe("EventBus robustness", () => {
  it("keeps delivering after a listener throws", () => {
    const bus = new EventBus<{ tick: number }>();
    const errors: unknown[] = [];
    const later = vi.fn();

    bus.on("tick", () => { throw new Error("listener exploded"); });
    bus.on("tick", later);
    bus.onListenerError((error) => errors.push(error));

    expect(() => bus.emit("tick", 1)).not.toThrow();
    // One broken subscriber must not silence every other feature on the bus.
    expect(later).toHaveBeenCalledWith(1);
    expect(errors).toHaveLength(1);
  });

  it("delivers to every listener registered before the emit", () => {
    const bus = new EventBus<{ tick: number }>();
    const second = vi.fn();

    // A listener that unsubscribes a later one must not remove it from the
    // current round: iterating the live set would skip an unvisited entry.
    const subscription = bus.on("tick", () => subscriptionTwo.dispose());
    const subscriptionTwo = bus.on("tick", second);

    bus.emit("tick", 1);

    expect(second).toHaveBeenCalledTimes(1);
    subscription.dispose();
  });

  it("does not deliver to listeners added during the same emit", () => {
    const bus = new EventBus<{ tick: number }>();
    const late = vi.fn();
    bus.on("tick", () => { bus.on("tick", late); });

    bus.emit("tick", 1);

    expect(late).not.toHaveBeenCalled();
  });

  it("reports how many listeners a type has", () => {
    const bus = new EventBus<{ tick: number }>();
    const subscription = bus.on("tick", () => {});

    expect(bus.listenerCount("tick")).toBe(1);
    subscription.dispose();
    expect(bus.listenerCount("tick")).toBe(0);
  });
});

describe("AssetStore revision collection", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  const store = async () => {
    const assets = new AssetStore(new MemoryStorageAdapter());
    await assets.initialize();
    const id = await assets.importAsset(bytes("v0"), { kind: "image", name: "layer.png", mime: "image/png" });
    return { assets, id };
  };

  it("drops an unreachable revision and its bytes", async () => {
    const { assets, id } = await store();
    await assets.commitRevision(id, bytes("v1"), "raster");

    // Every brush stroke is a full-layer revision; without collection the
    // storage grows for the whole session.
    expect(await assets.dropRevision(id, 0)).toBe(true);
    expect(assets.mustGet(id).revisions.map((revision) => revision.rev)).toEqual([1]);
    // The revision is gone from the ledger, not merely from disk.
    await expect(assets.read(id, 0)).rejects.toThrow(/Unknown asset revision/);
  });

  it("never drops the revision the document is looking at", async () => {
    const { assets, id } = await store();
    await assets.commitRevision(id, bytes("v1"), "raster");

    expect(await assets.dropRevision(id, 1)).toBe(false);
    expect(await assets.read(id)).not.toBeNull();
  });

  it("never drops the last remaining revision", async () => {
    const { assets, id } = await store();

    expect(await assets.dropRevision(id, 0)).toBe(false);
  });

  it("collects everything behind the head when history cannot reach it", async () => {
    const { assets, id } = await store();
    for (const value of ["v1", "v2", "v3"]) await assets.commitRevision(id, bytes(value), "raster");

    // Undo history is what made revisions 0..2 reachable, and it does not
    // survive a reload; without this sweep a layer keeps its whole past.
    expect(await assets.collectUnreachableRevisions()).toBe(3);
    expect(assets.mustGet(id).revisions.map((revision) => revision.rev)).toEqual([3]);
    expect(await assets.read(id)).not.toBeNull();
  });

  it("collects nothing when every asset is already at its only revision", async () => {
    const { assets } = await store();

    expect(await assets.collectUnreachableRevisions()).toBe(0);
  });

  it("ignores unknown assets and revisions", async () => {
    const { assets, id } = await store();

    expect(await assets.dropRevision(id, 42)).toBe(false);
    expect(await assets.dropRevision("asset:missing" as AssetId, 0)).toBe(false);
  });
});

describe("HistoryManager release reasons", () => {
  const step = (label: string, freed: string[]): ReversibleOperation => ({
    label,
    memoryEstimate: 100,
    redo: () => {},
    undo: () => {},
    free: (reason) => { freed.push(`${label}:${reason}`); },
  });

  it("tells a discarded redo branch apart from an evicted step", async () => {
    const freed: string[] = [];
    const history = new HistoryManager({ limit: 1000 });

    await history.execute(step("a", freed));
    await history.execute(step("b", freed));
    await history.undo();
    // Pushing over an undone step discards it: its result is unreachable.
    await history.execute(step("c", freed));

    expect(freed).toEqual(["b:discarded"]);

    const tight = new HistoryManager({ limit: 1 });
    await tight.execute(step("d", freed));
    await tight.execute(step("e", freed));

    // Falling off the front means the state before the step is unreachable.
    expect(freed).toEqual(["b:discarded", "d:evicted"]);
  });

  it("sheds steps under heap pressure before any budget is reached", async () => {
    const freed: string[] = [];
    const history = new HistoryManager({
      limit: 1000,
      memoryLimitBytes: Number.MAX_SAFE_INTEGER,
      heapPressure: () => 0.95,
    });

    for (const label of ["a", "b", "c", "d", "e", "f"]) await history.execute(step(label, freed));

    expect(history.undoCount).toBeLessThan(6);
    expect(freed.every((entry) => entry.endsWith(":evicted"))).toBe(true);
  });

  it("does not drain the timeline when steps weigh nothing on the heap", async () => {
    const freed: string[] = [];
    const weightless = (label: string): ReversibleOperation => ({
      label, memoryEstimate: 0, storageEstimate: 8_000_000,
      redo: () => {}, undo: () => {}, free: (reason) => { freed.push(`${label}:${reason}`); },
    });
    const history = new HistoryManager({ limit: 1000, heapPressure: () => 0.95 });

    for (const label of ["a", "b", "c", "d"]) await history.execute(weightless(label));

    // Revision-backed steps hold their buffers in storage. Shedding them frees
    // no heap at all, so heap pressure must not be able to consume the timeline.
    expect(history.undoCount).toBe(4);
    expect(freed).toEqual([]);
  });

  it("bounds the timeline by the storage budget once steps stop costing heap", async () => {
    const freed: string[] = [];
    const stored = (label: string): ReversibleOperation => ({
      label, memoryEstimate: 0, storageEstimate: 100,
      redo: () => {}, undo: () => {}, free: (reason) => { freed.push(`${label}:${reason}`); },
    });
    const history = new HistoryManager({ limit: 1000, storageLimitBytes: 250 });

    for (const label of ["a", "b", "c", "d", "e"]) await history.execute(stored(label));

    expect(history.storageBytes).toBeLessThanOrEqual(250);
    expect(history.undoCount).toBe(2);
    expect(freed).toEqual(["a:evicted", "b:evicted", "c:evicted"]);
  });

  it("keeps every step while the heap is roomy", async () => {
    const freed: string[] = [];
    const history = new HistoryManager({ limit: 1000, heapPressure: () => 0.1 });

    for (const label of ["a", "b", "c"]) await history.execute(step(label, freed));

    expect(history.undoCount).toBe(3);
    expect(freed).toEqual([]);
  });

  it("passes the reason down into a batch", async () => {
    const freed: string[] = [];
    const history = new HistoryManager({ limit: 1 });

    await history.executeBatch("pair", [step("x", freed), step("y", freed)]);
    await history.execute(step("z", freed));

    expect(freed).toEqual(["x:evicted", "y:evicted"]);
  });
});

describe("recording an edit that is already applied", () => {
  it("does not replay the operation", async () => {
    const history = new HistoryManager({ limit: 10 });
    let redos = 0;

    await history.record({ label: "Brush", memoryEstimate: 0, redo: () => { redos += 1; }, undo: () => {} });

    // An interactive edit is on screen the moment the gesture ends. Replaying it
    // means waiting for a round trip through storage, and the next gesture
    // starts inside that window and is lost.
    expect(redos).toBe(0);
    expect(history.undoCount).toBe(1);
  });

  it("undoes and redoes a recorded step like any other", async () => {
    const history = new HistoryManager({ limit: 10 });
    const applied: string[] = [];

    await history.record({ label: "Brush", memoryEstimate: 0, redo: () => { applied.push("redo"); }, undo: () => { applied.push("undo"); } });
    await history.undo();
    await history.redo();

    expect(applied).toEqual(["undo", "redo"]);
  });

  it("discards a pending redo branch when a recorded step lands on it", async () => {
    const freed: string[] = [];
    const history = new HistoryManager({ limit: 10 });
    const step = (label: string) => ({ label, memoryEstimate: 0, redo: () => {}, undo: () => {}, free: (reason: string) => { freed.push(`${label}:${reason}`); } });

    await history.execute(step("a"));
    await history.undo();
    await history.record(step("b"));

    expect(freed).toEqual(["a:discarded"]);
    expect(history.redoCount).toBe(0);
  });
});

describe("buffer revisions instead of buffer snapshots", () => {
  const layerBytes = (fill: number, size = 64) => new Uint8Array(size).fill(fill);

  const setup = async () => {
    const assets = new AssetStore(new MemoryStorageAdapter());
    await assets.initialize();
    const assetId = await assets.importAsset(layerBytes(1), { kind: "image", name: "layer.raw", mime: "application/octet-stream" });
    const shown: Uint8Array[] = [];
    return { assets, assetId, shown };
  };

  const commit = async (
    assets: AssetStore,
    assetId: AssetId,
    shown: Uint8Array[],
    bytes: Uint8Array,
  ) => {
    const previousRev = assets.mustGet(assetId).head;
    const nextRev = await assets.commitRevision(assetId, bytes, "raster");
    return createBufferRevisionOperation(
      { assets, assetId, label: "Brush", producedBy: "raster", apply: (value) => shown.push(value) },
      previousRev,
      nextRev,
    );
  };

  it("holds revision numbers rather than the buffers themselves", async () => {
    const { assets, assetId, shown } = await setup();

    const operation = await commit(assets, assetId, shown, layerBytes(2));

    // A snapshot pair of a 1920x1080 layer is 16 MB per step; here the heap
    // cost of a step is nothing and the bytes sit in storage.
    expect(operation.memoryEstimate).toBe(0);
    expect(operation.storageEstimate).toBe(64);
  });

  it("undo and redo move the head and hand back the right bytes", async () => {
    const { assets, assetId, shown } = await setup();
    const history = new HistoryManager({ limit: 10 });
    const operation = await commit(assets, assetId, shown, layerBytes(2));

    await history.execute(operation);
    expect(assets.mustGet(assetId).head).toBe(1);
    expect(shown.at(-1)?.[0]).toBe(2);

    await history.undo();
    expect(assets.mustGet(assetId).head).toBe(0);
    expect(shown.at(-1)?.[0]).toBe(1);

    await history.redo();
    expect(assets.mustGet(assetId).head).toBe(1);
    expect(shown.at(-1)?.[0]).toBe(2);
  });

  it("a discarded redo branch collects its own result", async () => {
    const { assets, assetId, shown } = await setup();
    const history = new HistoryManager({ limit: 10 });

    await history.execute(await commit(assets, assetId, shown, layerBytes(2)));
    await history.undo();
    await history.execute(await commit(assets, assetId, shown, layerBytes(3)));

    const revisions = assets.mustGet(assetId).revisions.map((revision) => revision.rev);
    // Revision 1 is unreachable now; revision 0 still backs the undo of the new step.
    expect(revisions).toContain(0);
    expect(revisions).not.toContain(1);
    expect(await history.undo()).toBe(true);
    expect(shown.at(-1)?.[0]).toBe(1);
  });

  it("an evicted step collects the state before it, never the one in view", async () => {
    const { assets, assetId, shown } = await setup();
    const history = new HistoryManager({ limit: 1 });

    await history.execute(await commit(assets, assetId, shown, layerBytes(2)));
    await history.execute(await commit(assets, assetId, shown, layerBytes(3)));

    const revisions = assets.mustGet(assetId).revisions.map((revision) => revision.rev);
    expect(revisions).not.toContain(0);
    expect(assets.mustGet(assetId).head).toBe(2);
    // The document still has bytes to draw after the collection.
    expect(await assets.read(assetId)).not.toBeNull();
  });

  it("many strokes cost storage, not heap", async () => {
    const { assets, assetId, shown } = await setup();
    const history = new HistoryManager({ limit: 100 });

    for (let step = 2; step < 22; step += 1) {
      await history.execute(await commit(assets, assetId, shown, layerBytes(step)));
    }

    expect(history.undoCount).toBe(20);
    expect(history.memoryBytes).toBe(0);
    expect(history.storageBytes).toBeGreaterThan(0);
  });
});
