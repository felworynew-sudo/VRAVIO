import { describe, expect, it } from "vitest";
import { WorkerPool } from "@vravio/kernel";
import { applyRasterFilter } from "@vravio/env-raster";
import { applyRasterFilterParallel, filterRenderClientFrom, type FilterRenderInput, type FilterWorkerLike } from "./filter-worker-pool";

/**
 * `filterRenderClientFrom` is tested against a stand-in the same way
 * `heal-membrane-pool.test.ts` tests `healMembraneClientFrom` — a real `Worker` is unavailable
 * under vitest and would test the platform, not this file's own message/abort/cleanup logic.
 */
function fakeWorker(reply: (sent: { pixels: ArrayBuffer; width: number; height: number; filterId: string; settings: Record<string, number> }) => { pixels: ArrayBuffer } | null) {
  let terminated = false;
  const sent: unknown[] = [];
  const worker: FilterWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      const typed = message as { pixels: ArrayBuffer; width: number; height: number; filterId: string; settings: Record<string, number> };
      sent.push(typed);
      const answer = reply(typed);
      if (answer) queueMicrotask(() => worker.onmessage?.({ data: { type: "rendered", requestId: 0, pixels: answer.pixels } }));
    },
    terminate: () => { terminated = true; },
  };
  return { worker, sent, wasTerminated: () => terminated };
}

describe("filterRenderClientFrom", () => {
  it("resolves with the worker's own reply", async () => {
    const rendered = new Uint8ClampedArray([9, 9, 9, 255]);
    const { worker } = fakeWorker(() => ({ pixels: rendered.buffer as ArrayBuffer }));
    const client = filterRenderClientFrom(worker);
    const result = await client.run({ pixels: new Uint8ClampedArray(4), width: 1, height: 1, filterId: "box_blur", settings: {} }, new AbortController().signal);
    expect([...result]).toEqual([9, 9, 9, 255]);
  });

  it("rejects with an AbortError when the signal is already aborted", async () => {
    const { worker } = fakeWorker(() => ({ pixels: new Uint8ClampedArray(4).buffer as ArrayBuffer }));
    const client = filterRenderClientFrom(worker);
    const controller = new AbortController();
    controller.abort();
    await expect(client.run({ pixels: new Uint8ClampedArray(4), width: 1, height: 1, filterId: "box_blur", settings: {} }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when the worker reports an error", async () => {
    const worker: FilterWorkerLike = {
      onmessage: null, onerror: null,
      postMessage: () => { queueMicrotask(() => worker.onmessage?.({ data: { type: "error", requestId: 0, message: "boom" } })); },
      terminate: () => {},
    };
    const client = filterRenderClientFrom(worker);
    await expect(client.run({ pixels: new Uint8ClampedArray(4), width: 1, height: 1, filterId: "box_blur", settings: {} }, new AbortController().signal))
      .rejects.toThrow("boom");
  });

  it("dispose terminates the underlying worker", () => {
    const { worker, wasTerminated } = fakeWorker(() => null);
    filterRenderClientFrom(worker).dispose();
    expect(wasTerminated()).toBe(true);
  });

  it("does not transfer the caller's own input buffer — it stays readable after the call", async () => {
    const { worker } = fakeWorker((sent) => sent);
    const client = filterRenderClientFrom(worker);
    const input: FilterRenderInput = { pixels: new Uint8ClampedArray([1, 2, 3, 4]), width: 1, height: 1, filterId: "box_blur", settings: {} };
    await client.run(input, new AbortController().signal);
    expect([...input.pixels]).toEqual([1, 2, 3, 4]);
  });
});

describe("applyRasterFilterParallel", () => {
  const w = 40, h = 37;

  function fixture(): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 31 + 7) % 256;
    return pixels;
  }

  /** A pool whose "workers" run the real `applyRasterFilter` in-process — end-to-end proof that
   *  the band planning, the padded slice each worker is handed, and the stitched-back-together
   *  result together reproduce the single-region call exactly, through the real `WorkerPool`
   *  queueing/dispatch this project already ships (not a mock of it). */
  function realFilterPool(size: number) {
    return new WorkerPool<FilterRenderInput, Uint8ClampedArray>(
      () => ({
        run: async (input) => applyRasterFilter(input.pixels, input.width, input.height, input.filterId, input.settings),
        dispose: () => {},
      }),
      size,
    );
  }

  it("a parallel-safe filter across 4 bands matches the single-region result byte-for-byte", async () => {
    const source = fixture();
    const settings = { radius: 6 };
    const whole = applyRasterFilter(source, w, h, "gaussian_blur", settings);
    const pool = realFilterPool(4);
    const banded = await applyRasterFilterParallel(pool, source, w, h, "gaussian_blur", settings);
    expect([...banded]).toEqual([...whole]);
  });

  it("a filter outside the parallel-safe set still runs as one whole-image request", async () => {
    const source = fixture();
    const whole = applyRasterFilter(source, w, h, "twirl", { amount: 40 });
    const pool = realFilterPool(4);
    const dispatched = await applyRasterFilterParallel(pool, source, w, h, "twirl", { amount: 40 });
    expect([...dispatched]).toEqual([...whole]);
  });

  it("a single-worker pool still produces the correct result (falls back to one band)", async () => {
    const source = fixture();
    const whole = applyRasterFilter(source, w, h, "median", { radius: 4 });
    const pool = realFilterPool(1);
    const banded = await applyRasterFilterParallel(pool, source, w, h, "median", { radius: 4 });
    expect([...banded]).toEqual([...whole]);
  });
});
