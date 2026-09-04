import { accumulateUniquePixelBytes, decodeRasterAsset, encodeRasterAsset, isRasterAsset, visitPixelBuffers, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";

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
  const source = new OffscreenCanvas(sampledWidth, sampledHeight);
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
 */
export function withActiveLayerPixels(state: RasterDocumentState, pixels: Uint8ClampedArray): RasterDocumentState {
  const bounds = { x: 0, y: 0, width: state.width, height: state.height };
  return { ...state, layers: state.layers.map((layer) => layer.id === state.activeLayerId ? { ...layer, pixels, bounds, width: state.width, height: state.height } : layer) };
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

export function withLayerMaskPixels(state: RasterDocumentState, layerId: string, pixels: Uint8ClampedArray): RasterDocumentState {
  return { ...state, layers: state.layers.map((layer) => layer.id === layerId && layer.mask ? { ...layer, mask: { ...layer.mask, pixels: rgbaToMask(pixels) } } : layer) };
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
