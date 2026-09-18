import { applyRasterFilterDeep, filterRunsAtDepth, filterWorkRegion, layerDocumentPixels, toRgba8, type PixelBuffer, type RasterDocumentState, type RasterLayer, type RasterRect } from "@vravio/env-raster";
import { applyRasterFilterParallel, filterWorkerPool } from "./filter-worker-pool";

export interface LayerFilterResult {
  /**
   * The same result at the layer's own depth, in the layer's own local frame, when the layer is
   * deep and the filter declared depth support (master-plan §59.2b).
   *
   * `before`/`after` above stay exactly what they always were — document-sized and 8-bit — so
   * every existing caller keeps working and the preview still has something to composite. A caller
   * that commits pixels uses this instead when it is present, and writes it back with
   * `writeLocalRegion`; the two shapes are not interchangeable, which is why this is a separate
   * field rather than a change of meaning in the old ones (CLAUDE.md §4).
   */
  readonly deep?: { readonly rect: RasterRect; readonly before: PixelBuffer; readonly after: PixelBuffer };
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
  // A deep layer and a filter that declares depth support take the deep path instead (master-plan
  // §59.2b): the 8-bit round trip below is lossless at 8 bits and is the narrow part at 16 or 32.
  // Everything else keeps the worker path — the honest babl fallback, said out loud in the panel.
  if ((layer.tiles?.depth ?? 8) !== 8 && filterRunsAtDepth(filterId)) return filterLayerPixelsDeep(state, layer, filterId, settings);
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

/**
 * The same job at the layer's own depth, in the layer's own frame.
 *
 * On the main thread rather than in the pool: the worker protocol moves `Uint8ClampedArray`, and
 * teaching it deep buffers is its own change with its own risks. The filters that declare depth
 * support are the cheap ones — separable blurs and point functions — so the cost of keeping this
 * synchronous is bounded, and it is measured rather than assumed (see filters-deep.test.ts).
 */
async function filterLayerPixelsDeep(
  state: RasterDocumentState, layer: RasterLayer, filterId: string, settings: Record<string, number>,
): Promise<LayerFilterResult> {
  const { width, height } = state;
  const rect: RasterRect = { x: 0, y: 0, width: layer.bounds.width, height: layer.bounds.height };
  const deepBefore = layer.tiles!.readLocalRegionDeep(rect);
  const deepAfter = applyRasterFilterDeep(deepBefore, rect.width, rect.height, filterId, settings);
  const changed: RasterRect = {
    x: Math.max(0, layer.bounds.x), y: Math.max(0, layer.bounds.y),
    width: Math.max(0, Math.min(width, layer.bounds.x + layer.bounds.width) - Math.max(0, layer.bounds.x)),
    height: Math.max(0, Math.min(height, layer.bounds.y + layer.bounds.height) - Math.max(0, layer.bounds.y)),
  };
  // The 8-bit, document-sized pair the preview and every existing caller expect, placed from the
  // layer's own frame. The deep pair rides alongside for whoever is going to commit it.
  const before = layerDocumentPixels(layer, width, height).slice();
  const after = before.slice();
  const eight = toRgba8(deepAfter);
  for (let y = 0; y < rect.height; y += 1) {
    const documentY = layer.bounds.y + y;
    if (documentY < 0 || documentY >= height) continue;
    for (let x = 0; x < rect.width; x += 1) {
      const documentX = layer.bounds.x + x;
      if (documentX < 0 || documentX >= width) continue;
      const from = (y * rect.width + x) * 4, to = (documentY * width + documentX) * 4;
      after[to] = eight[from]!; after[to + 1] = eight[from + 1]!; after[to + 2] = eight[from + 2]!; after[to + 3] = eight[from + 3]!;
    }
  }
  return { before, after, changed, deep: { rect, before: deepBefore, after: deepAfter } };
}
