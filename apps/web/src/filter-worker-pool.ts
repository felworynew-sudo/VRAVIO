import { WorkerPool, type WorkerTaskClient } from "@vravio/kernel";
import { PARALLEL_SAFE_FILTERS, paddingForFilter, planFilterBands } from "@vravio/env-raster";

/**
 * docs/master-plan.md §37.3 item 4 — the dispatch half of the adaptive row-band plan
 * `filter-tiling.ts` computes. `filter-worker.ts` already applies one filter to one buffer off
 * the main thread (`FilterGalleryDialog.tsx`'s live preview); this reuses that same worker
 * script unchanged, through the same `WorkerPool` `heal-membrane-pool.ts` already proved out —
 * the only new thing here is asking for several row bands in parallel instead of one whole-image
 * request, and stitching the padded results back together with no seam (see filter-tiling.ts's
 * own doc comment for why the padding makes that exact).
 */

export interface FilterRenderInput {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly filterId: string;
  readonly settings: Record<string, number>;
}

/** The one shape this file needs from a Worker — same convention as `heal-membrane-pool.ts`'s
 *  own `HealMembraneWorkerLike`: property-assigned `onmessage`/`onerror`, not `addEventListener`,
 *  so a test double can stand in without reimplementing `EventTarget`. */
export interface FilterWorkerLike {
  onmessage: ((event: { data: { type: string; requestId: number; pixels?: ArrayBuffer; message?: string } }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

function abortError(): Error {
  const error = new Error("Filter render was cancelled");
  error.name = "AbortError";
  return error;
}

/** Wraps an already-constructed worker-like object into a `WorkerTaskClient` — split out for the
 *  same reason `healMembraneClientFrom` is: a test hands it a fake `FilterWorkerLike` and checks
 *  the message/abort/cleanup behaviour without a real `Worker` (unavailable under vitest). */
export function filterRenderClientFrom(worker: FilterWorkerLike): WorkerTaskClient<FilterRenderInput, Uint8ClampedArray> {
  return {
    run(input, signal) {
      return new Promise<Uint8ClampedArray>((resolve, reject) => {
        if (signal.aborted) { reject(abortError()); return; }

        const cleanup = () => {
          worker.onmessage = null;
          worker.onerror = null;
          signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => { cleanup(); reject(abortError()); };
        worker.onmessage = (event) => {
          cleanup();
          if (event.data.type === "error") { reject(new Error(event.data.message ?? "Filter render failed")); return; }
          resolve(new Uint8ClampedArray(event.data.pixels!));
        };
        worker.onerror = (event) => { cleanup(); reject(new Error(event.message || "Filter render failed")); };
        signal.addEventListener("abort", onAbort, { once: true });

        // Copied into a fresh, worker-bound buffer — `input.pixels` may be a subarray view this
        // function itself carved out of a shared source a moment ago (see
        // `applyRasterFilterParallel` below), and transferring (detaching) it out from under a
        // caller still assembling other bands from the same source would be exactly the footgun
        // `heal-membrane-pool.ts`'s own comment warns about.
        const pixels = input.pixels.slice().buffer;
        worker.postMessage(
          { type: "render", requestId: 0, pixels, width: input.width, height: input.height, filterId: input.filterId, settings: input.settings },
          [pixels],
        );
      });
    },
    dispose: () => worker.terminate(),
  };
}

function createFilterWorkerClient(): WorkerTaskClient<FilterRenderInput, Uint8ClampedArray> {
  const worker = new Worker(new URL("./filter-worker.ts", import.meta.url), { type: "module" }) as unknown as FilterWorkerLike;
  return filterRenderClientFrom(worker);
}

let pool: WorkerPool<FilterRenderInput, Uint8ClampedArray> | null = null;

/** Lazily created on first use, same as `healMembranePool()` — a document nobody has opened the
 *  Filter Gallery on pays nothing for this. Sized to the machine's own core count (capped, both
 *  because a filter render is not the only thing competing for cores and because a two-core
 *  machine gains nothing from planning four bands it cannot actually run in parallel). */
export function filterWorkerPool(): WorkerPool<FilterRenderInput, Uint8ClampedArray> {
  if (!pool) {
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
    pool = new WorkerPool(createFilterWorkerClient, Math.max(1, Math.min(4, cores ?? 4)));
  }
  return pool;
}

/**
 * Applies a filter across `pool`'s workers in row bands instead of one whole-image request, for
 * the filters `filter-tiling.ts` has verified are safe to split. Anything not in
 * `PARALLEL_SAFE_FILTERS` — or an image too small to be worth splitting — still goes through as
 * a single request, so this is a drop-in replacement for the existing one-worker call, not a
 * separate path callers need to branch on themselves.
 */
export async function applyRasterFilterParallel(
  pool: WorkerPool<FilterRenderInput, Uint8ClampedArray>,
  source: Uint8ClampedArray, width: number, height: number, filterId: string, settings: Record<string, number>,
  signal?: AbortSignal,
): Promise<Uint8ClampedArray> {
  const runOptions = signal ? { signal } : {};
  if (!PARALLEL_SAFE_FILTERS.has(filterId)) {
    return pool.run({ pixels: source, width, height, filterId, settings }, runOptions);
  }
  const padding = paddingForFilter(filterId, settings);
  const bands = planFilterBands(height, padding, pool.size);
  if (bands.length <= 1) return pool.run({ pixels: source, width, height, filterId, settings }, runOptions);

  const rendered = await Promise.all(bands.map(async (band) => {
    const sliceStart = Math.max(0, band.startY - padding);
    const sliceEnd = Math.min(height, band.endY + padding);
    const slice = source.subarray(sliceStart * width * 4, sliceEnd * width * 4);
    const pixels = await pool.run({ pixels: slice, width, height: sliceEnd - sliceStart, filterId, settings }, runOptions);
    return { band, sliceStart, pixels };
  }));

  const output = new Uint8ClampedArray(source.length);
  for (const { band, sliceStart, pixels } of rendered) {
    const bandOffsetInSlice = band.startY - sliceStart;
    const bandHeight = band.endY - band.startY;
    output.set(pixels.subarray(bandOffsetInSlice * width * 4, (bandOffsetInSlice + bandHeight) * width * 4), band.startY * width * 4);
  }
  return output;
}
