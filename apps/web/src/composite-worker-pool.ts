import { WorkerPool, type WorkerTaskClient } from "@vravio/kernel";
import { TileJobScheduler, type TileJobDescriptor } from "@vravio/env-raster";

/**
 * docs/master-plan.md §37.3 item 4 — the dispatch half of the "simple layer stack" fast path,
 * same `WorkerPool` machinery `filter-worker-pool.ts` already proved out, plus real admission
 * control through `TileJobScheduler` (the Krita-semantics port) instead of a bare `Promise.all`.
 *
 * Scope, deliberately narrow: this pool composites only the *background, non-interactive* case —
 * many dirty tiles needing a fresh composite at once (a large filter/adjustment, an undo across a
 * wide area, opening a document) — never the interactive brush-stroke repaint path, which stays
 * synchronous on the main thread exactly as it is today (docs/master-plan.md §37.6.3's own finding
 * that moving per-dab work off-thread would add worker round-trip latency to the highest-frequency,
 * most latency-sensitive path in the app). `RasterTileCache.update()` itself is untouched; this is
 * an additive, opt-in bulk path a caller reaches for only when it actually has many tiles to redo
 * at once and every one of them passes `isSimpleLayerStack`.
 */

export interface CompositeBlendInput {
  readonly width: number;
  readonly height: number;
  readonly documentX: number;
  readonly documentY: number;
  readonly layers: readonly { pixels: Uint8ClampedArray; opacity: number; blendMode: string }[];
}

/** Same shape `FilterWorkerLike` uses in `filter-worker-pool.ts` — property-assigned handlers so a
 *  test double can stand in without reimplementing `EventTarget`. */
export interface CompositeWorkerLike {
  onmessage: ((event: { data: { type: string; requestId: number; pixels?: ArrayBuffer; message?: string } }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

function abortError(): Error {
  const error = new Error("Composite render was cancelled");
  error.name = "AbortError";
  return error;
}

export function compositeRenderClientFrom(worker: CompositeWorkerLike): WorkerTaskClient<CompositeBlendInput, Uint8ClampedArray> {
  return {
    run(input, signal) {
      return new Promise<Uint8ClampedArray>((resolve, reject) => {
        if (signal.aborted) { reject(abortError()); return; }
        let aborted = false;
        const cleanup = () => { worker.onmessage = null; worker.onerror = null; signal.removeEventListener("abort", onAbort); };
        const onAbort = () => { aborted = true; };
        worker.onmessage = (event) => {
          cleanup();
          if (aborted || signal.aborted) { reject(abortError()); return; }
          if (event.data.type === "error") { reject(new Error(event.data.message ?? "Composite render failed")); return; }
          resolve(new Uint8ClampedArray(event.data.pixels!));
        };
        worker.onerror = (event) => { cleanup(); reject(aborted || signal.aborted ? abortError() : new Error(event.message || "Composite render failed")); };
        signal.addEventListener("abort", onAbort, { once: true });

        // Copied, not transferred from the caller's own view: `input.layers[n].pixels` was just
        // materialised by `layerDocumentPixels` a moment ago and nothing else holds a reference to
        // it, but copying here keeps this client's contract identical to `filterRenderClientFrom`'s
        // own (deliberately conservative — see that file's comment on the same line) rather than
        // relying on every future caller remembering never to reuse the buffer after calling this.
        const layers = input.layers.map((layer) => ({ pixels: layer.pixels.slice().buffer, opacity: layer.opacity, blendMode: layer.blendMode }));
        worker.postMessage(
          { type: "blend", requestId: 0, width: input.width, height: input.height, documentX: input.documentX, documentY: input.documentY, layers },
          layers.map((layer) => layer.pixels),
        );
      });
    },
    dispose: () => worker.terminate(),
  };
}

function createCompositeWorkerClient(): WorkerTaskClient<CompositeBlendInput, Uint8ClampedArray> {
  const worker = new Worker(new URL("./composite-worker.ts", import.meta.url), { type: "module" }) as unknown as CompositeWorkerLike;
  return compositeRenderClientFrom(worker);
}

let pool: WorkerPool<CompositeBlendInput, Uint8ClampedArray> | null = null;

/** Lazily created, sized like `filterWorkerPool()` — a document that never triggers a bulk
 *  recompute pays nothing for this. */
export function compositeWorkerPool(): WorkerPool<CompositeBlendInput, Uint8ClampedArray> {
  if (!pool) {
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
    pool = new WorkerPool(createCompositeWorkerClient, Math.max(1, Math.min(4, cores ?? 4)));
  }
  return pool;
}

export interface TileBlendJob extends TileJobDescriptor {
  readonly sequentiality: "concurrent";
  readonly input: CompositeBlendInput;
}

/**
 * Dispatches every job in `jobs` across `pool`, gated through `scheduler` rather than a bare
 * `Promise.all` — each job is admitted as a `"concurrent"` `TileJobScheduler` job (independent
 * tiles never depend on each other, the same reasoning `TileJobScheduler`'s own doc comment gives
 * for Krita's real CONCURRENT stroke jobs) and released the moment its own render settles, success
 * or failure. Returns results in the same order `jobs` was given, not completion order.
 *
 * This is the scheduler's first real consumer: today every job here happens to be `"concurrent"`,
 * so `Promise.all` alone would behave identically — the win is that a *future* caller needing a
 * `"barrier"` (e.g. "every dirty tile must be fully repainted before this snapshot is taken") gets
 * real, tested admission control for free by adding that one job through the same `scheduler`,
 * instead of this function growing a bespoke wait-for-everything special case of its own.
 */
export async function dispatchTileBlendJobs(
  pool: WorkerPool<CompositeBlendInput, Uint8ClampedArray>,
  scheduler: TileJobScheduler,
  jobs: readonly TileBlendJob[],
  signal?: AbortSignal,
): Promise<Uint8ClampedArray[]> {
  const runOptions = signal ? { signal } : {};
  return Promise.all(jobs.map(async (job) => {
    // Polling `canStart` is only safe because every job this function ever submits is
    // `"concurrent"` — nothing it admits can itself block another of its own jobs, so this loop
    // always resolves on its first check in practice. A caller sharing `scheduler` with an actual
    // `"sequential"`/`"barrier"` job (not something this function does, but something a future
    // caller could) would need a real resolvable queue instead of polling — not built here because
    // nothing in this codebase needs it yet, and building it unused would be exactly the kind of
    // speculative machinery CLAUDE.md warns against.
    while (!scheduler.canStart(job)) await Promise.resolve();
    scheduler.admit(job);
    try {
      return await pool.run(job.input, runOptions);
    } finally {
      scheduler.release(job.id);
    }
  }));
}
