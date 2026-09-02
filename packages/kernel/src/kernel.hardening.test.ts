import { describe, expect, it, vi } from "vitest";
import { AssetStore, EventBus, HistoryManager, MemoryStorageAdapter, type AssetId, type ReversibleOperation } from "./index";

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
