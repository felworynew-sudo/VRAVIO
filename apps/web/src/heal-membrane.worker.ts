import { solveHealMembrane } from "@vravio/env-raster";

/**
 * The multigrid membrane solve, off the main thread — `patch.tsx`'s own live drag preview is the
 * first real caller (`heal-membrane-pool.ts`), through `@vravio/kernel`'s `WorkerPool`. One
 * request in flight at a time: the pool never calls a slot's `run` again before the previous one
 * resolves, so this worker does not need its own request-multiplexing the way `filter-worker.ts`
 * (shared by several concurrent dialogs) does.
 *
 * `offsetsRgb` is mutated in place by `solveHealMembrane` the same way it is on the main thread —
 * posted back as a *new* transferable buffer (not the one the caller sent, which structured-clone
 * already copied into the worker's own realm) so the caller's own copy is never silently detached
 * out from under it.
 */
interface SolveRequest {
  interior: ArrayBuffer;
  width: number;
  height: number;
  offsetsRgb: ArrayBuffer;
  sweepScale: number;
}
interface SolveResponse {
  offsetsRgb: ArrayBuffer;
}
interface HealMembraneWorkerScope {
  onmessage: ((event: MessageEvent<SolveRequest>) => void) | null;
  postMessage(message: SolveResponse, transfer: Transferable[]): void;
}
const workerScope = self as unknown as HealMembraneWorkerScope;

workerScope.onmessage = (event) => {
  const { interior, width, height, offsetsRgb, sweepScale } = event.data;
  const interiorArray = new Uint8Array(interior);
  const offsets = new Int16Array(offsetsRgb);
  solveHealMembrane(interiorArray, width, height, offsets, sweepScale);
  workerScope.postMessage({ offsetsRgb: offsets.buffer }, [offsets.buffer]);
};
