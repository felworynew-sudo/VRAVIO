import { opaqueBoundsOf } from "./layer-bounds";
import type { RasterLayer, RasterLayerMask, RasterRect } from "./types";

/**
 * GIMP's undo record, in this project's terms: one rectangle of pixels, swapped in and out.
 *
 * `gimp_drawable_push_undo(drawable, desc, buffer, x, y, width, height)` keeps only the part of
 * the drawable an edit actually touched, and `gimp_drawable_real_swap_pixels` puts it back by
 * *exchanging* it with what is there now — so the same record serves undo and redo, and one
 * rectangle is the entire cost. A brush stroke on a 1920×1080 layer used to write the whole
 * eight-megabyte layer to storage on release, hash it and index it; the rectangle it painted is
 * usually a few hundred kilobytes and never leaves memory.
 *
 * The swap is the reason there is one buffer and not two: after undoing, the record holds what
 * redo needs, which is exactly what it holds before undoing again.
 */

function clampRect(rect: RasterRect, width: number, height: number): RasterRect {
  const left = Math.max(0, Math.min(width, Math.floor(rect.x)));
  const top = Math.max(0, Math.min(height, Math.floor(rect.y)));
  const right = Math.max(left, Math.min(width, Math.ceil(rect.x + rect.width)));
  const bottom = Math.max(top, Math.min(height, Math.ceil(rect.y + rect.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The rectangle's RGBA content, cut out of a document-sized buffer. */
export function cropRegion(pixels: Uint8ClampedArray, documentWidth: number, rect: RasterRect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.y + y) * documentWidth + rect.x) * 4;
    out.set(pixels.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return out;
}

/** The rectangle's mask bytes, taken from a document-sized RGBA buffer the way `rgbaToMask` does. */
export function cropRegionAsMask(pixels: Uint8ClampedArray, documentWidth: number, rect: RasterRect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const index = ((rect.y + y) * documentWidth + rect.x + x) * 4;
      out[y * rect.width + x] = Math.round((pixels[index]! + pixels[index + 1]! + pixels[index + 2]!) / 3);
    }
  }
  return out;
}

/** Grows a layer's own buffer so `rect` fits inside its bounds, keeping what it already holds. */
function growToInclude(layer: RasterLayer, rect: RasterRect): void {
  const bounds = layer.bounds;
  const left = Math.min(bounds.x, rect.x), top = Math.min(bounds.y, rect.y);
  const right = Math.max(bounds.x + bounds.width, rect.x + rect.width);
  const bottom = Math.max(bounds.y + bounds.height, rect.y + rect.height);
  if (left === bounds.x && top === bounds.y && right === bounds.x + bounds.width && bottom === bounds.y + bounds.height) return;

  const width = right - left, height = bottom - top;
  const grown = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < bounds.height; y += 1) {
    const from = y * bounds.width * 4;
    grown.set(layer.pixels.subarray(from, from + bounds.width * 4), ((bounds.y + y - top) * width + (bounds.x - left)) * 4);
  }
  layer.bounds = { x: left, y: top, width, height };
  layer.width = width;
  layer.height = height;
  layer.pixels = grown;
}

/** Trims a layer back to what it holds, the invariant `setLayerPixels` keeps for whole buffers. */
function trimInPlace(layer: RasterLayer): void {
  const local = opaqueBoundsOf(layer.pixels, layer.bounds.width, layer.bounds.height);
  const inner = local ?? { x: 0, y: 0, width: 1, height: 1 };
  if (inner.x === 0 && inner.y === 0 && inner.width === layer.bounds.width && inner.height === layer.bounds.height) return;
  const trimmed = new Uint8ClampedArray(inner.width * inner.height * 4);
  for (let y = 0; y < inner.height; y += 1) {
    const from = ((inner.y + y) * layer.bounds.width + inner.x) * 4;
    trimmed.set(layer.pixels.subarray(from, from + inner.width * 4), y * inner.width * 4);
  }
  layer.bounds = { x: layer.bounds.x + inner.x, y: layer.bounds.y + inner.y, width: inner.width, height: inner.height };
  layer.width = inner.width;
  layer.height = inner.height;
  layer.pixels = trimmed;
}

/**
 * Puts `patch` into the layer at `rect` and hands back what was there — GIMP's
 * `gimp_drawable_real_swap_pixels`, with this project's stored-in-its-own-bounds layers.
 *
 * The layer grows to hold the rectangle if the edit being undone had extended it, and is trimmed
 * again afterwards, because "a layer's buffer is exactly its opaque bounds" is the invariant every
 * reader here relies on (CLAUDE.md §4: the pair must never be assigned apart).
 */
export function swapLayerRegion(
  layer: RasterLayer, rect: RasterRect, patch: Uint8ClampedArray, documentWidth: number, documentHeight: number,
): Uint8ClampedArray {
  const region = clampRect(rect, documentWidth, documentHeight);
  if (!region.width || !region.height) return patch;
  const before = layer.pixels;
  growToInclude(layer, region);
  // Copied *before* the write loop touches a single byte, not after. `layer-ops.ts`'s
  // `duplicateLayer` shares this exact buffer object with a copy rather than cloning it (§37.5),
  // safe only because — per its own doc comment — nothing in this package ever writes through a
  // shared buffer; `changeRasterDocument` in apps/web shares a layer's buffer the same way with
  // its undo/redo snapshots of every non-pixel command (rename, reorder, opacity, blend mode, …).
  // A version of this function once copied only *after* the loop below had already written
  // through whatever `layer.pixels` was at the time — an identity-comparison leftover from before
  // `pixelsRevision` existed, harmless for that purpose (the fresh object still compared unequal
  // to the old one) but not for this one: the write already went through the original, possibly
  // still-shared buffer before the "fresh" one was ever made, so anyone else holding that
  // reference silently saw the edit too. `duplicate-swap-sharing.test.ts` reproduces it. When
  // `growToInclude` above already built a fresh buffer (the edit grew the layer), `layer.pixels`
  // is already private and this is a no-op check; otherwise, copy now, while it is still just a
  // copy and not a repair.
  if (layer.pixels === before) layer.pixels = before.slice();

  const bounds = layer.bounds;
  const previous = new Uint8ClampedArray(region.width * region.height * 4);
  for (let y = 0; y < region.height; y += 1) {
    const rowStart = ((region.y + y - bounds.y) * bounds.width + (region.x - bounds.x)) * 4;
    const rowBytes = region.width * 4;
    previous.set(layer.pixels.subarray(rowStart, rowStart + rowBytes), y * rowBytes);
    layer.pixels.set(patch.subarray(y * rowBytes, y * rowBytes + rowBytes), rowStart);
  }
  trimInPlace(layer);
  layer.pixelsRevision += 1;
  return previous;
}

/**
 * The same exchange for a layer mask, whose store is always exactly document-sized (unlike a
 * layer's, a mask's own bounds never move — docs/master-plan.md §37.6.3, types.ts's own comment
 * on `RasterLayerMask.tiles`), so unlike `swapLayerRegion` this never needs `reframe()`'d: every
 * call is a plain clone-then-write.
 *
 * `mask.tiles.clone()` before writing — not written in place — for the identical reason
 * `swapLayerRegion`'s comment above documents for a layer's buffer: `duplicateLayer` and
 * `changeRasterDocument` both share a mask's `tiles` object across layers/snapshots without
 * cloning it, and a `TileStore` instance mutates its own tile map in place on `writeLocalRegion`
 * (`Map.set`), so writing through the shared instance directly would silently corrupt whichever
 * of them still holds that reference — the same bug `duplicate-swap-sharing.test.ts` catches for
 * the flat-buffer version of this exact field. `clone()` is O(tile count), not O(mask area): only
 * the tiles `region` actually overlaps get rebuilt, which is the real win this migration is for —
 * the `mask.pixels.slice()` this replaced cost a whole-mask copy on every call, regardless of how
 * small the edit was (measured at 8.5ms on a 4000×3000 mask, docs/master-plan.md §37.6.2).
 */
export function swapMaskRegion(
  mask: RasterLayerMask, rect: RasterRect, patch: Uint8ClampedArray, documentWidth: number, documentHeight: number,
): Uint8ClampedArray {
  const region = clampRect(rect, documentWidth, documentHeight);
  if (!region.width || !region.height) return patch;
  const previous = mask.tiles.readLocalRegion(region);
  mask.tiles = mask.tiles.clone();
  mask.tiles.writeLocalRegion(region, patch);
  mask.pixelsRevision += 1;
  return previous;
}
