import { describe, expect, it } from "vitest";
import { WorkerPool } from "@vravio/kernel";
import { TileJobScheduler, blendSimpleLayerStack } from "@vravio/env-raster";
import { compositeRenderClientFrom, dispatchTileBlendJobs, type CompositeBlendInput, type CompositeWorkerLike, type TileBlendJob } from "./composite-worker-pool";

/** Same stand-in pattern `filter-worker-pool.test.ts` uses for `FilterWorkerLike` — a real
 *  `Worker` is unavailable under vitest and would test the platform, not this file's own logic. */
function fakeWorker(reply: (sent: { width: number; height: number; documentX: number; documentY: number; layers: { pixels: ArrayBuffer; opacity: number; blendMode: string }[] }) => { pixels: ArrayBuffer } | null) {
  let terminated = false;
  const worker: CompositeWorkerLike = {
    onmessage: null, onerror: null,
    postMessage: (message) => {
      const typed = message as { width: number; height: number; documentX: number; documentY: number; layers: { pixels: ArrayBuffer; opacity: number; blendMode: string }[] };
      const answer = reply(typed);
      if (answer) queueMicrotask(() => worker.onmessage?.({ data: { type: "blended", requestId: 0, pixels: answer.pixels } }));
    },
    terminate: () => { terminated = true; },
  };
  return { worker, wasTerminated: () => terminated };
}

describe("compositeRenderClientFrom", () => {
  it("resolves with the worker's own reply", async () => {
    const rendered = new Uint8ClampedArray([9, 9, 9, 255]);
    const { worker } = fakeWorker(() => ({ pixels: rendered.buffer as ArrayBuffer }));
    const client = compositeRenderClientFrom(worker);
    const result = await client.run({ width: 1, height: 1, documentX: 0, documentY: 0, layers: [{ pixels: new Uint8ClampedArray(4), opacity: 1, blendMode: "normal" }] }, new AbortController().signal);
    expect([...result]).toEqual([9, 9, 9, 255]);
  });

  it("rejects with an AbortError when the signal is already aborted", async () => {
    const { worker } = fakeWorker(() => ({ pixels: new Uint8ClampedArray(4).buffer as ArrayBuffer }));
    const client = compositeRenderClientFrom(worker);
    const controller = new AbortController();
    controller.abort();
    await expect(client.run({ width: 1, height: 1, documentX: 0, documentY: 0, layers: [] }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when the worker reports an error", async () => {
    const worker: CompositeWorkerLike = {
      onmessage: null, onerror: null,
      postMessage: () => { queueMicrotask(() => worker.onmessage?.({ data: { type: "error", requestId: 0, message: "boom" } })); },
      terminate: () => {},
    };
    const client = compositeRenderClientFrom(worker);
    await expect(client.run({ width: 1, height: 1, documentX: 0, documentY: 0, layers: [] }, new AbortController().signal)).rejects.toThrow("boom");
  });

  it("dispose terminates the underlying worker", () => {
    const { worker, wasTerminated } = fakeWorker(() => null);
    compositeRenderClientFrom(worker).dispose();
    expect(wasTerminated()).toBe(true);
  });

  it("does not transfer the caller's own input buffers — they stay readable after the call", async () => {
    const { worker } = fakeWorker((sent) => ({ pixels: sent.layers[0]!.pixels }));
    const client = compositeRenderClientFrom(worker);
    const input: CompositeBlendInput = { width: 1, height: 1, documentX: 0, documentY: 0, layers: [{ pixels: new Uint8ClampedArray([1, 2, 3, 4]), opacity: 1, blendMode: "normal" }] };
    await client.run(input, new AbortController().signal);
    expect([...input.layers[0]!.pixels]).toEqual([1, 2, 3, 4]);
  });
});

describe("dispatchTileBlendJobs", () => {
  /** A pool whose "workers" run the real `blendSimpleLayerStack` in-process — end-to-end proof
   *  that dispatch through the real `WorkerPool` + `TileJobScheduler` reproduces the direct,
   *  single-call result exactly. */
  function realCompositePool(size: number) {
    return new WorkerPool<CompositeBlendInput, Uint8ClampedArray>(
      () => ({ run: async (input) => blendSimpleLayerStack(input.width, input.height, input.layers, input.documentX, input.documentY), dispose: () => {} }),
      size,
    );
  }

  it("dispatches every job and returns results in the order given, not completion order", async () => {
    const pool = realCompositePool(2);
    const scheduler = new TileJobScheduler();
    const solid = (value: number) => { const pixels = new Uint8ClampedArray(4); pixels[0] = value; pixels[3] = 255; return pixels; };
    const jobs: TileBlendJob[] = [
      { id: "tile-0", sequentiality: "concurrent", input: { width: 1, height: 1, documentX: 0, documentY: 0, layers: [{ pixels: solid(10), opacity: 1, blendMode: "normal" }] } },
      { id: "tile-1", sequentiality: "concurrent", input: { width: 1, height: 1, documentX: 1, documentY: 0, layers: [{ pixels: solid(20), opacity: 1, blendMode: "normal" }] } },
      { id: "tile-2", sequentiality: "concurrent", input: { width: 1, height: 1, documentX: 2, documentY: 0, layers: [{ pixels: solid(30), opacity: 1, blendMode: "normal" }] } },
    ];
    const results = await dispatchTileBlendJobs(pool, scheduler, jobs);
    expect(results.map((pixels) => pixels[0])).toEqual([10, 20, 30]);
    expect(scheduler.runningCount).toBe(0);
  });

  it("releases every job even when one of them rejects", async () => {
    const pool = new WorkerPool<CompositeBlendInput, Uint8ClampedArray>(
      () => ({
        run: async (input) => {
          if (input.documentX === 1) throw new Error("boom");
          return new Uint8ClampedArray(4);
        },
        dispose: () => {},
      }),
      2,
    );
    const scheduler = new TileJobScheduler();
    const jobs: TileBlendJob[] = [
      { id: "tile-0", sequentiality: "concurrent", input: { width: 1, height: 1, documentX: 0, documentY: 0, layers: [] } },
      { id: "tile-1", sequentiality: "concurrent", input: { width: 1, height: 1, documentX: 1, documentY: 0, layers: [] } },
    ];
    await expect(dispatchTileBlendJobs(pool, scheduler, jobs)).rejects.toThrow("boom");
    expect(scheduler.runningCount).toBe(0);
  });

  it("a barrier job admitted on the same scheduler waits for all dispatched tile jobs to finish", async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const pool = new WorkerPool<CompositeBlendInput, Uint8ClampedArray>(
      () => ({ run: async () => { await gate; return new Uint8ClampedArray(4); }, dispose: () => {} }),
      2,
    );
    const scheduler = new TileJobScheduler();
    const jobs: TileBlendJob[] = [
      { id: "tile-0", sequentiality: "concurrent", input: { width: 1, height: 1, documentX: 0, documentY: 0, layers: [] } },
    ];
    const dispatched = dispatchTileBlendJobs(pool, scheduler, jobs);
    await Promise.resolve(); // let the job actually get admitted before checking the barrier
    expect(scheduler.canStart({ id: "export-barrier", sequentiality: "barrier" })).toBe(false);
    resolveFirst();
    await dispatched;
    expect(scheduler.canStart({ id: "export-barrier", sequentiality: "barrier" })).toBe(true);
  });
});
