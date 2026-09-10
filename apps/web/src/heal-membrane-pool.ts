import { WorkerPool, type WorkerTaskClient } from "@vravio/kernel";

/**
 * The first real consumer of `@vravio/kernel`'s own `WorkerPool` — built, tested, and never
 * actually wired to anything until now (`docs/migration-plan.md` §6.2 names this exact gap:
 * "решено и записано: кто владеет пикселями, что уходит в Worker" was still unchecked). The
 * multigrid membrane solve (`solveHealMembrane`, heal_membrane.ts) is the first thing moved off
 * the main thread through it: pure computation with no DOM/WebGL dependency, and the one already
 * measured (`patch.bench.test.ts`) costing ~100ms+ per call — exactly the kind of work that has
 * no business running on the thread a drag is waiting on.
 */

export interface HealMembraneInput {
  readonly interior: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly offsetsRgb: Int16Array;
  readonly sweepScale: number;
}
export interface HealMembraneOutput {
  readonly offsetsRgb: Int16Array;
}

/** The one shape this file needs from a Worker — `onmessage`/`onerror` property assignment
 *  (this project's own established convention: `plugins/host.ts`'s `PluginWorkerLike`,
 *  `filter-worker.ts`'s callers) rather than `addEventListener`, both because each client only
 *  ever has one request in flight at a time (so there is never more than one handler to keep
 *  track of) and because it is what lets a test double stand in for a real `Worker` without
 *  reimplementing `EventTarget`. */
export interface HealMembraneWorkerLike {
  onmessage: ((event: { data: { offsetsRgb: ArrayBuffer } }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

function abortError(): Error {
  const error = new Error("Heal-membrane solve was cancelled");
  error.name = "AbortError";
  return error;
}

/** Wraps an already-constructed worker-like object into a `WorkerTaskClient` — split out from
 *  `createHealMembraneWorkerClient` below purely so a test can hand it a fake `HealMembraneWorkerLike`
 *  and check the actual message/abort/cleanup behaviour without spinning up a real `Worker`
 *  (unavailable outside a browser — this same code path runs under Node/jsdom in
 *  `contract.test.ts`'s generic tool harness). */
export function healMembraneClientFrom(worker: HealMembraneWorkerLike): WorkerTaskClient<HealMembraneInput, HealMembraneOutput> {
  return {
    run(input, signal) {
      return new Promise<HealMembraneOutput>((resolve, reject) => {
        if (signal.aborted) { reject(abortError()); return; }

        const cleanup = () => {
          worker.onmessage = null;
          worker.onerror = null;
          signal.removeEventListener("abort", onAbort);
        };
        // Settles the promise immediately on abort — `WorkerPool` frees this slot for its next
        // queued task the moment this rejects, without waiting for the worker to actually finish
        // the stale solve still running inside it (a synchronous multigrid sweep has no mid-loop
        // yield point `postMessage` could interrupt, so real cancellation would mean
        // `worker.terminate()` — discarding this whole client, which the pool does not expect
        // `run()` to do to itself). The eventual, now-unlistened-for reply from that stale solve
        // is simply dropped below: `onmessage` was already cleared by this same cleanup. Not free
        // — that worker instance is a *little* slower to become truly idle for its next real
        // request — but strictly better than the alternative this replaces, which blocked the
        // main thread with no way to abort at all.
        const onAbort = () => { cleanup(); reject(abortError()); };
        worker.onmessage = (event) => { cleanup(); resolve({ offsetsRgb: new Int16Array(event.data.offsetsRgb) }); };
        worker.onerror = (event) => { cleanup(); reject(new Error(event.message || "Heal-membrane worker failed")); };
        signal.addEventListener("abort", onAbort, { once: true });

        // Copied into fresh, worker-bound buffers rather than transferring the caller's own —
        // `input.interior`/`input.offsetsRgb` are `PreparedPatchRegion`'s own fields, and
        // transferring (detaching) them out from under a caller that might still read `interior`
        // elsewhere would be exactly the footgun `beginLiveScene3D`'s own `isCancelled` comment
        // warns about for a different resource. A membrane region is small (padded to the
        // selection's own bounds, not the document), so this copy is not the expensive part.
        const interior = input.interior.slice().buffer;
        const offsetsRgb = input.offsetsRgb.slice().buffer;
        worker.postMessage({ interior, width: input.width, height: input.height, offsetsRgb, sweepScale: input.sweepScale }, [interior, offsetsRgb]);
      });
    },
    dispose: () => worker.terminate(),
  };
}

function createHealMembraneWorkerClient(): WorkerTaskClient<HealMembraneInput, HealMembraneOutput> {
  const worker = new Worker(new URL("./heal-membrane.worker.ts", import.meta.url), { type: "module" }) as unknown as HealMembraneWorkerLike;
  return healMembraneClientFrom(worker);
}

let pool: WorkerPool<HealMembraneInput, HealMembraneOutput> | null = null;

/** Lazily created on first use — a document that never touches Patch/healing pays nothing for
 *  this, not even the worker script's own parse-and-start cost. Small (2 slots): this is an
 *  interactive live-preview solve, not a batch job, and each slot is its own persistent Worker. */
export function healMembranePool(): WorkerPool<HealMembraneInput, HealMembraneOutput> {
  if (!pool) pool = new WorkerPool(createHealMembraneWorkerClient, 2);
  return pool;
}
