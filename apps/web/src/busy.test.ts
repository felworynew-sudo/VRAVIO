import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginBusy, useBusyStore, withBusy, withBusyPainted } from "./busy";

const labels = () => useBusyStore.getState().tasks.map((task) => task.label);

describe("busy state", () => {
  beforeEach(() => { useBusyStore.setState({ tasks: [] }); });

  it("reports what is running while synchronous work runs", () => {
    let seen: string[] = [];

    withBusy("Rasterising", () => { seen = labels(); });

    expect(seen).toEqual(["Rasterising"]);
  });

  it("clears after asynchronous work", async () => {
    const promise = withBusy("Exporting", async () => "done");

    expect(labels()).toEqual(["Exporting"]);
    await expect(promise).resolves.toBe("done");
    expect(labels()).toEqual([]);
  });

  it("clears when the work throws", () => {
    expect(() => withBusy("Filtering", () => { throw new Error("boom"); })).toThrow("boom");

    // An operation that fails must not leave the pointer spinning forever.
    expect(labels()).toEqual([]);
  });

  it("clears when asynchronous work rejects", async () => {
    await expect(withBusy("Loading", async () => { throw new Error("offline"); })).rejects.toThrow("offline");

    expect(labels()).toEqual([]);
  });

  it("tracks several operations at once and reports the newest", () => {
    const first = beginBusy("Loading a model");
    const second = beginBusy("Removing a background");

    expect(labels()).toEqual(["Loading a model", "Removing a background"]);
    second();
    expect(labels()).toEqual(["Loading a model"]);
    first();
    expect(labels()).toEqual([]);
  });

  it("ignores a release called twice", () => {
    const release = beginBusy("Working");
    const other = beginBusy("Other");

    release();
    release();

    // A double release used to take somebody else's task off the list.
    expect(labels()).toEqual(["Other"]);
  });

  it("lets the state reach the screen before blocking work starts", async () => {
    const order: string[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      order.push("frame");
      queueMicrotask(() => callback(0));
      return 0;
    });

    await withBusyPainted("Slow", () => { order.push("work"); });

    // Setting a flag and immediately monopolising the thread paints nothing:
    // both land in the same frame and the user sees no change at all.
    expect(order).toEqual(["frame", "frame", "work"]);
    expect(labels()).toEqual([]);
    vi.unstubAllGlobals();
  });
});
