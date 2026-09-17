import { filterWorkRegion, layerDocumentPixels, type RasterDocumentState, type RasterLayer, type RasterRect } from "@vravio/env-raster";
import { applyRasterFilterParallel, filterWorkerPool } from "./filter-worker-pool";

export interface LayerFilterResult {
  /** The layer at document size before the filter — what undo restores. */
  readonly before: Uint8ClampedArray;
  /** The same, filtered. Identical to `before` outside `changed`. */
  readonly after: Uint8ClampedArray;
  /** The document rectangle the filter actually wrote. */
  readonly changed: RasterRect;
}

/**
 * Runs a catalogue filter on one layer, off the main thread, over only as much of the document as
 * the filter can affect — the one door every Filter-menu path goes through (panel preview, panel
 * apply, one-click filters, Repeat Filter).
 *
 * Owner, docs/master-plan.md §58.1: "speed depends on the size of the canvas, not on the layer I
 * chose", and Oil Paint hanging the tab. Every path used to hand the filter a whole-canvas buffer,
 * and the apply paths ran it synchronously on the main thread. Here a neighbourhood filter
 * (`filterWorkRegion`, pinned equal to the whole-canvas result by filter-tiling.test.ts) computes
 * the layer's extent plus its reach — intersected with the selection — split across the worker
 * pool; a filter keyed to the canvas itself (a distortion about its centre) still takes the whole
 * document, in the pool too. `signal` lets a superseded preview stop its workers.
 */
export async function filterLayerPixels(
  state: RasterDocumentState, layer: RasterLayer, filterId: string, settings: Record<string, number>, signal?: AbortSignal,
): Promise<LayerFilterResult> {
  const { width, height } = state;
  const before = layerDocumentPixels(layer, width, height).slice();
  const left = Math.max(0, layer.bounds.x), top = Math.max(0, layer.bounds.y);
  const right = Math.min(width, layer.bounds.x + layer.bounds.width), bottom = Math.min(height, layer.bounds.y + layer.bounds.height);
  const content: RasterRect = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  const region = filterWorkRegion(width, height, content, state.selection?.bounds ?? null, filterId, settings);
  if (!region) {
    const after = await applyRasterFilterParallel(filterWorkerPool(), before, width, height, filterId, settings, signal);
    return { before, after, changed: { x: 0, y: 0, width, height } };
  }
  const { input, output } = region;
  if (!output.width || !output.height) return { before, after: before.slice(), changed: output };
  const cropped = new Uint8ClampedArray(input.width * input.height * 4);
  for (let y = 0; y < input.height; y += 1) {
    const from = ((input.y + y) * width + input.x) * 4;
    cropped.set(before.subarray(from, from + input.width * 4), y * input.width * 4);
  }
  const filtered = await applyRasterFilterParallel(filterWorkerPool(), cropped, input.width, input.height, filterId, settings, signal);
  const after = before.slice();
  for (let y = 0; y < output.height; y += 1) {
    const from = ((output.y - input.y + y) * input.width + (output.x - input.x)) * 4;
    after.set(filtered.subarray(from, from + output.width * 4), ((output.y + y) * width + output.x) * 4);
  }
  return { before, after, changed: output };
}
