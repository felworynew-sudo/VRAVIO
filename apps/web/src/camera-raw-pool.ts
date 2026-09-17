import { WorkerPool, type WorkerTaskClient } from "@vravio/kernel";
import type { CameraRawFilterSettings, CameraRawFrame } from "@vravio/env-raster";

export interface CameraRawRenderInput {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly settings: CameraRawFilterSettings;
  readonly frame?: CameraRawFrame;
}

interface CameraRawWorkerLike {
  onmessage: ((event: { data: { type: string; pixels?: ArrayBuffer; message?: string } }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

const abortError = () => { const error = new Error("Camera Raw render was cancelled"); error.name = "AbortError"; return error; };

/**
 * Same contract as `filter-worker-pool.ts`'s client, for the same reason spelled out there: a
 * worker cannot stop a synchronous render halfway, so an aborted request keeps its slot until the
 * worker answers and is then rejected — the next request never receives a stale result.
 */
function cameraRawClientFrom(worker: CameraRawWorkerLike): WorkerTaskClient<CameraRawRenderInput, Uint8ClampedArray> {
  return {
    run(input, signal) {
      return new Promise<Uint8ClampedArray>((resolve, reject) => {
        if (signal.aborted) { reject(abortError()); return; }
        let aborted = false;
        const onAbort = () => { aborted = true; };
        const cleanup = () => { worker.onmessage = null; worker.onerror = null; signal.removeEventListener("abort", onAbort); };
        worker.onmessage = (event) => {
          cleanup();
          if (aborted || signal.aborted) { reject(abortError()); return; }
          if (event.data.type === "error") { reject(new Error(event.data.message ?? "Camera Raw render failed")); return; }
          resolve(new Uint8ClampedArray(event.data.pixels!));
        };
        worker.onerror = (event) => { cleanup(); reject(aborted || signal.aborted ? abortError() : new Error(event.message || "Camera Raw render failed")); };
        signal.addEventListener("abort", onAbort, { once: true });
        const pixels = input.pixels.slice().buffer;
        worker.postMessage({ pixels, width: input.width, height: input.height, settings: input.settings, frame: input.frame }, [pixels]);
      });
    },
    dispose: () => worker.terminate(),
  };
}

let pool: WorkerPool<CameraRawRenderInput, Uint8ClampedArray> | null = null;

/** Two slots: the on-screen preview, and a full-resolution Apply that must not wait behind it. */
export function cameraRawPool(): WorkerPool<CameraRawRenderInput, Uint8ClampedArray> {
  if (!pool) pool = new WorkerPool(() => cameraRawClientFrom(new Worker(new URL("./camera-raw-worker.ts", import.meta.url), { type: "module" }) as unknown as CameraRawWorkerLike), 2);
  return pool;
}

export function renderCameraRaw(input: CameraRawRenderInput, signal?: AbortSignal): Promise<Uint8ClampedArray> {
  return cameraRawPool().run(input, signal ? { signal } : {});
}
