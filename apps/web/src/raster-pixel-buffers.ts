import { accumulateUniquePixelBytes, decodeRasterAsset, encodeRasterAsset, isRasterAsset, TileStore, visitPixelBuffers, type RasterDocumentState, type RasterLayer, type RasterLayerMask, type RasterRect } from "@vravio/env-raster";

/**
 * Pure pixel-buffer plumbing shared by `RasterWorkspace.tsx`'s render and
 * commit pipelines — split out purely to bring the host component's own
 * line count down (docs/migration-plan.md §8), not because any of this
 * changed. No React, no kernel access: every function here reads only its
 * own arguments and returns a new buffer or document snapshot.
 */

/** Asset storage takes plain bytes; a clamped view is not one. */
/**
 * A layer buffer in the form assets hold it.
 *
 * The same container the round-trip uses, so a layer's asset means the same
 * thing whether a brush stroke wrote it or another environment did — and
 * handing that asset to an editor that never saw this document is enough,
 * because the bytes carry their own dimensions.
 */
export const toBytes = (pixels: Uint8ClampedArray, width: number, height: number): Uint8Array =>
  encodeRasterAsset(pixels, width, height);

/** Layer bytes out of an asset, tolerating buffers stored before the container existed. */
export const fromBytes = (bytes: Uint8Array): Uint8ClampedArray =>
  isRasterAsset(bytes) ? decodeRasterAsset(bytes).pixels : new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

export function putPixels(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray, width: number, height: number): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
}

/**
 * Scaling a mip tile needs a tiny intermediate canvas. Creating one for every
 * invalidated tile makes pan/zoom allocate DOM-backed resources at pointer
 * rate, so retain a deliberately small LRU by sampled size. A canvas is used
 * synchronously by `drawImage`, therefore returning it to this pool is safe
 * as soon as the call finishes.
 */
const mipBlitCanvases = new Map<string, OffscreenCanvas>();
const MAX_MIP_BLIT_CANVASES = 4;

function mipBlitCanvas(width: number, height: number): OffscreenCanvas {
  const key = `${width}x${height}`;
  const cached = mipBlitCanvases.get(key);
  if (cached) {
    // Map insertion order is our LRU order.
    mipBlitCanvases.delete(key);
    mipBlitCanvases.set(key, cached);
    return cached;
  }
  const source = new OffscreenCanvas(width, height);
  mipBlitCanvases.set(key, source);
  if (mipBlitCanvases.size > MAX_MIP_BLIT_CANVASES) {
    const oldest = mipBlitCanvases.keys().next().value as string | undefined;
    if (oldest) mipBlitCanvases.delete(oldest);
  }
  return source;
}

/** Blits a region-sized buffer at its document offset, leaving the rest of the canvas untouched. */
export function putRegionPixels(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray, region: RasterRect, step = 1): void {
  if (!region.width || !region.height) return;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  if (step <= 1) {
    context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, region.width, region.height), region.x, region.y);
    return;
  }
  // A subsampled tile carries one pixel per `step`; the browser scales it back
  // up, which is what makes compositing at a mip level worth doing at all.
  const sampledWidth = Math.ceil(region.width / step), sampledHeight = Math.ceil(region.height / step);
  const source = mipBlitCanvas(sampledWidth, sampledHeight);
  const sourceContext = source.getContext("2d");
  if (!sourceContext) throw new Error("Canvas 2D is not available");
  sourceContext.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, sampledWidth, sampledHeight), 0, 0);
  context.clearRect(region.x, region.y, region.width, region.height);
  context.drawImage(source, 0, 0, sampledWidth, sampledHeight, region.x, region.y, region.width, region.height);
}

/** Copies one rectangle out of a full-canvas buffer, for the single-layer blit fast path. */
export function cropPixels(pixels: Uint8ClampedArray, width: number, region: RasterRect): Uint8ClampedArray {
  const output = new Uint8ClampedArray(region.width * region.height * 4);
  for (let row = 0; row < region.height; row += 1) {
    const start = ((region.y + row) * width + region.x) * 4;
    output.set(pixels.subarray(start, start + region.width * 4), row * region.width * 4);
  }
  return output;
}

/**
 * The document with the active layer showing a canvas-sized working buffer.
 *
 * The bounds have to move with the buffer. A layer is stored at the size of its
 * content and read with its own stride, so handing it a canvas-sized buffer
 * while leaving the old rectangle in place makes every row read from the wrong
 * offset — the picture comes out as diagonal streaks.
 *
 * `tiles`, not a `pixels` field: `RasterLayer` stopped having a `pixels` field at all once it
 * moved to `TileStore` (docs/master-plan.md §37.6.3) — every real reader (`layerDocumentPixels`/
 * `layerPixelsView`, and through them the whole compositor) reads `layer.tiles` exclusively. A
 * layer object built with `{ ...layer, pixels }` was invisible to all of them: `canDirectRasterPreviewBlit`'s
 * single-layer, no-effects, normal-blend, opacity-1 fast path never calls this function at all (it
 * blits the raw buffer straight to canvas), which is exactly why this only ever showed up on a
 * multi-layer document, or any blend mode/opacity/mask/effect off its narrow allow-list — the
 * *ordinary* editing case, not the fresh-empty-single-layer one a quick smoke test reaches for
 * first. Below that fast path, every preview frame silently composited the layer's last *committed*
 * tiles instead of the in-progress buffer this function was asked to show: a live brush stroke
 * invisible until release, and a live Skew/Distort/Warp frame reading whatever stale tiles the
 * compositor's own bounds math happened to land on — the exact "diagonal streaks" this comment's
 * own next paragraph already named, just from a different cause than the one it was written for.
 */
/**
 * Per-layer cache backing `withActiveLayerPixels`/`withLayersPixels`'s optional `region` argument
 * — same self-invalidating-by-identity trick `maskScratchByCommitted` below already uses for masks,
 * keyed by the layer object a drag's every frame shares (nothing commits mid-drag, so the layer
 * object and its `pixelsRevision` stay put until release) and re-seeded whenever either changes.
 *
 * Without this, a canvas-sized `TileStore.fromPixels(pixels, ...)` — the correct fix for the
 * phantom-`pixels`-field migration bug this file's own history describes — would run on *every*
 * `pointermove` of *every* brush stroke, quad/warp drag frame, transform, etc.: an O(width×height)
 * full-document re-tile per frame, reintroducing at the tiles step the exact "whole-buffer cost
 * every frame" this package has spent §37.3 removing everywhere else. `TileStore.clone()` is
 * O(tile count) (it copies the map, not the tiles) and `writeRegion()` is O(tiles touched) — so once
 * one frame has paid for the canvas-sized materialisation, every later frame in the same drag pays
 * only for the small rectangle it actually changed.
 */
const activeLayerPreviewCache = new WeakMap<RasterLayer, { pixelsRevision: number; tiles: TileStore }>();

/**
 * `pixels`, materialised into `TileStore`-shaped tiles for one layer — the shared half of
 * `withActiveLayerPixels`/`withLayersPixels`. `region`, when given, names the only rectangle this
 * particular call actually changed relative to the layer's last cached preview frame (or its last
 * *committed* tiles, on the first frame of a drag): everything outside it is reused via `clone()`
 * rather than reconverted. Passing no `region` (or a stale/dimension-mismatched cache) always
 * rebuilds the whole store from `pixels`, which is correct for any caller — `region` is purely a
 * fast path, never a source of different pixels than the no-region call would produce, and the
 * `transform-drag-cache`-style tests alongside this file's own tests hold both paths to the same
 * byte-for-byte result.
 */
function previewTilesForLayer(state: RasterDocumentState, layer: RasterLayer, pixels: Uint8ClampedArray, region: RasterRect | null | undefined): TileStore {
  const cached = activeLayerPreviewCache.get(layer);
  if (region && cached && cached.pixelsRevision === layer.pixelsRevision && cached.tiles.width === state.width && cached.tiles.height === state.height) {
    const tiles = cached.tiles.clone();
    tiles.writeRegion(region, pixels, state.width);
    activeLayerPreviewCache.set(layer, { pixelsRevision: layer.pixelsRevision, tiles });
    return tiles;
  }
  const tiles = TileStore.fromPixels(pixels, state.width, state.height);
  activeLayerPreviewCache.set(layer, { pixelsRevision: layer.pixelsRevision, tiles });
  return tiles;
}

export function withActiveLayerPixels(state: RasterDocumentState, pixels: Uint8ClampedArray, region?: RasterRect | null): RasterDocumentState {
  const bounds = { x: 0, y: 0, width: state.width, height: state.height };
  return { ...state, layers: state.layers.map((layer) => layer.id === state.activeLayerId ? { ...layer, tiles: previewTilesForLayer(state, layer, pixels, region), bounds, width: state.width, height: state.height } : layer) };
}

/**
 * The document with several layers each showing a canvas-sized working
 * buffer — the multi-layer counterpart of {@link withActiveLayerPixels},
 * for a linked-layer group drag where every dragged layer needs its own
 * in-progress buffer swapped in for one composite, not just the active one.
 * Same `tiles`, not `pixels`, fix as {@link withActiveLayerPixels} — see its own doc comment,
 * including the optional `region` fast path.
 */
export function withLayersPixels(state: RasterDocumentState, updates: ReadonlyMap<string, Uint8ClampedArray>, region?: RasterRect | null): RasterDocumentState {
  if (updates.size === 0) return state;
  const bounds = { x: 0, y: 0, width: state.width, height: state.height };
  return { ...state, layers: state.layers.map((layer) => {
    const pixels = updates.get(layer.id);
    return pixels ? { ...layer, tiles: previewTilesForLayer(state, layer, pixels, region), bounds, width: state.width, height: state.height } : layer;
  }) };
}

export function maskToRgba(mask: Uint8ClampedArray): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(mask.length * 4);
  for (let index = 0; index < mask.length; index += 1) { const value = mask[index]!; const offset = index * 4; pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value; pixels[offset + 3] = 255; }
  return pixels;
}

export function rgbaToMask(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(pixels.length / 4);
  for (let index = 0; index < mask.length; index += 1) mask[index] = Math.round((pixels[index * 4]! + pixels[index * 4 + 1]! + pixels[index * 4 + 2]!) / 3);
  return mask;
}

/**
 * Scratch mask buffers, keyed by the mask object they were cloned from.
 *
 * A stroke keeps writing into the same scratch for as long as the layer's committed mask content
 * stays the same — which is exactly the length of one stroke, because committing bumps
 * `pixelsRevision` (docs/master-plan.md §37.6.2, the same replacement as this package's other five
 * identity-keyed caches — `mask.pixels` itself used to be reassigned to a fresh object on commit,
 * which would have invalidated an identity-keyed WeakMap just as well, but only as an accident of
 * how commit happened to be written, not because anything here asked for it). So the key
 * invalidates itself and there is nothing to remember to clear.
 *
 * `scratch` (flat, one byte per pixel) is the buffer this function actually writes into every
 * frame — `TileStore` has no per-pixel write cheap enough for that. `tiles` mirrors it for the
 * `RasterLayerMask` this function hands back, kept in sync by `writeLocalRegion`-ing only the
 * band each frame touched (docs/master-plan.md §37.6.3), not rebuilt from `scratch` on every
 * frame: a full `TileStore.fromPixels(scratch, ...)` per pointermove would reintroduce, at the
 * mask→tiles step, the exact "whole-buffer conversion every frame" cost this function's own next
 * paragraph describes fixing at the RGBA→mask step.
 */
const maskScratchByCommitted = new WeakMap<RasterLayerMask, { pixelsRevision: number; scratch: Uint8ClampedArray; tiles: TileStore }>();

/**
 * The document with a mask stroke's *dirty band* swapped in — the region counterpart of
 * {@link withLayerMaskPixels}.
 *
 * Painting on a mask used to convert the whole document-sized RGBA working buffer back to a mask
 * on every frame, and then composite the whole document, because the preview's region fast path
 * was written for pixel layers only and masks silently fell through to the full path. On a
 * 1920x1080 document that is a two-million-pixel conversion plus a full composite per frame,
 * which is why the owner found painting on a mask far worse than painting on a layer.
 *
 * Here only the band the stroke has just touched is converted, into a buffer reused across the
 * stroke, and only that band is composited.
 */
export function withLayerMaskRegion(state: RasterDocumentState, layerId: string, rgba: Uint8ClampedArray, region: RasterRect): RasterDocumentState {
  const layer = state.layers.find((item) => item.id === layerId);
  if (!layer?.mask) return state;
  const mask = layer.mask;
  let entry = maskScratchByCommitted.get(mask);
  if (!entry || entry.pixelsRevision !== mask.pixelsRevision) {
    const flat = mask.tiles.toPixels();
    entry = { pixelsRevision: mask.pixelsRevision, scratch: flat, tiles: TileStore.fromPixels(flat, state.width, state.height, 1) };
    maskScratchByCommitted.set(mask, entry);
  }
  const scratch = entry.scratch;
  const left = Math.max(0, region.x), top = Math.max(0, region.y);
  const right = Math.min(state.width, region.x + region.width), bottom = Math.min(state.height, region.y + region.height);
  if (right <= left || bottom <= top) return state;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = y * state.width + x;
      // The same reduction `rgbaToMask` uses for the whole buffer — the average of the three
      // channels, not just red. They are equal on the grey a mask actually holds, but two
      // spellings of one convention are two chances to disagree later.
      scratch[index] = Math.round((rgba[index * 4]! + rgba[index * 4 + 1]! + rgba[index * 4 + 2]!) / 3);
    }
  }
  const touched = { x: left, y: top, width: right - left, height: bottom - top };
  const patch = new Uint8ClampedArray(touched.width * touched.height);
  for (let y = 0; y < touched.height; y += 1) {
    const from = (touched.y + y) * state.width + touched.x;
    patch.set(scratch.subarray(from, from + touched.width), y * touched.width);
  }
  entry.tiles.writeLocalRegion(touched, patch);
  return { ...state, layers: state.layers.map((item) => item.id === layerId && item.mask ? { ...item, mask: { ...item.mask, tiles: entry.tiles } } : item) };
}
export function withLayerMaskPixels(state: RasterDocumentState, layerId: string, pixels: Uint8ClampedArray): RasterDocumentState {
  return { ...state, layers: state.layers.map((layer) => layer.id === layerId && layer.mask ? { ...layer, mask: { ...layer.mask, tiles: TileStore.fromPixels(rgbaToMask(pixels), state.width, state.height, 1) } } : layer) };
}

/**
 * What a step between these two states actually keeps alive.
 *
 * Both snapshots share their buffers with the document, so charging history for
 * every layer in both of them overstated a single shape by ninety-six megabytes
 * and had the budget dropping undo depth within a dozen operations. Only the
 * buffers the two states disagree about are held open by the step.
 */
export function stateDeltaBytes(before: RasterDocumentState, after: RasterDocumentState): number {
  const shared = new Set<ArrayBufferView>();
  accumulateUniquePixelBytes(before, shared);
  // Whatever the two states have in common is already counted, so what this
  // adds is exactly what the step keeps alive on its own.
  const added = accumulateUniquePixelBytes(after, shared);

  const inAfter = new Set<ArrayBufferView>();
  accumulateUniquePixelBytes(after, inAfter);
  let dropped = 0;
  visitPixelBuffers(before, (buffer) => { if (!inAfter.has(buffer)) dropped += buffer.byteLength; });
  return added + dropped;
}
