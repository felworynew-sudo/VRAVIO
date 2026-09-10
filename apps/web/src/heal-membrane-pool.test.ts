import { describe, expect, it } from "vitest";
import { healMembraneClientFrom, type HealMembraneWorkerLike } from "./heal-membrane-pool";

/**
 * `healMembraneClientFrom` wraps a worker-like object into a `WorkerTaskClient` — tested against
 * a stand-in here rather than a real `Worker` (unavailable in this test environment, and even in
 * a browser would be testing the platform, not this file's own message/abort/cleanup logic), the
 * same reasoning `plugins/host.test.ts`'s own `fakeWorker` already gives for the plugin host.
 */

function fakeWorker(reply: (sent: { offsetsRgb: ArrayBuffer }) => { offsetsRgb: ArrayBuffer } | null) {
  let terminated = false;
  const sent: { offsetsRgb: ArrayBuffer }[] = [];
  const worker: HealMembraneWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      const typed = message as { offsetsRgb: ArrayBuffer };
      sent.push(typed);
      const answer = reply(typed);
      if (answer) queueMicrotask(() => worker.onmessage?.({ data: answer }));
    },
    terminate: () => { terminated = true; },
  };
  return { worker, sent, wasTerminated: () => terminated };
}

function offsets(...values: number[]): Int16Array {
  return new Int16Array(values);
}

describe("healMembraneClientFrom", () => {
  it("resolves with the worker's own reply", async () => {
    const solved = offsets(1, 2, 3);
    const { worker } = fakeWorker(() => ({ offsetsRgb: solved.buffer as ArrayBuffer }));
    const client = healMembraneClientFrom(worker);
    const result = await client.run({ interior: new Uint8Array([1]), width: 1, height: 1, offsetsRgb: offsets(0, 0, 0), sweepScale: 1 }, new AbortController().signal);
    expect([...result.offsetsRgb]).toEqual([1, 2, 3]);
  });

  it("rejects with an AbortError instead of the worker's reply when the signal is already aborted", async () => {
    const { worker } = fakeWorker(() => ({ offsetsRgb: offsets(9, 9, 9).buffer as ArrayBuffer }));
    const client = healMembraneClientFrom(worker);
    const controller = new AbortController();
    controller.abort();
    await expect(client.run({ interior: new Uint8Array([1]), width: 1, height: 1, offsetsRgb: offsets(0, 0, 0), sweepScale: 1 }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with an AbortError the instant abort() fires mid-solve, without waiting for the worker's own (now-ignored) reply", async () => {
    let resolveReply: (() => void) | null = null;
    const worker: HealMembraneWorkerLike = {
      onmessage: null,
      onerror: null,
      // The reply never comes on its own here — only when the test explicitly fires it via
      // `resolveReply`, simulating a solve that is still running when the abort happens.
      postMessage: () => { resolveReply = () => worker.onmessage?.({ data: { offsetsRgb: offsets(5, 5, 5).buffer as ArrayBuffer } } as never); },
      terminate: () => {},
    };
    const client = healMembraneClientFrom(worker);
    const controller = new AbortController();
    const run = client.run({ interior: new Uint8Array([1]), width: 1, height: 1, offsetsRgb: offsets(0, 0, 0), sweepScale: 1 }, controller.signal);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    // The stale reply arriving afterward must not resurrect the already-settled promise —
    // `onmessage` was cleared by the same cleanup the abort path runs.
    expect(worker.onmessage).toBeNull();
    resolveReply!();
  });

  it("rejects when the worker reports an error", async () => {
    const worker: HealMembraneWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: () => { queueMicrotask(() => worker.onerror?.({ message: "boom" })); },
      terminate: () => {},
    };
    const client = healMembraneClientFrom(worker);
    await expect(client.run({ interior: new Uint8Array([1]), width: 1, height: 1, offsetsRgb: offsets(0, 0, 0), sweepScale: 1 }, new AbortController().signal))
      .rejects.toThrow("boom");
  });

  it("dispose terminates the underlying worker", () => {
    const { worker, wasTerminated } = fakeWorker(() => null);
    healMembraneClientFrom(worker).dispose();
    expect(wasTerminated()).toBe(true);
  });

  it("does not transfer the caller's own input buffers — they stay readable after the call", async () => {
    const { worker } = fakeWorker((sent) => sent);
    const client = healMembraneClientFrom(worker);
    const input = { interior: new Uint8Array([1, 0, 1]), width: 3, height: 1, offsetsRgb: offsets(4, 5, 6), sweepScale: 1 };
    await client.run(input, new AbortController().signal);
    // If `postMessage` had transferred `input.offsetsRgb.buffer` directly (instead of a sliced
    // copy), reading it here would throw on a detached ArrayBuffer.
    expect([...input.offsetsRgb]).toEqual([4, 5, 6]);
  });
});
