import { describe, expect, it } from "vitest";
import { createRasterLayer, setLayerPixels } from "./index";
import { cropRegion, cropRegionAsMask, swapLayerRegion, swapMaskRegion } from "./region-patch";
import { TileStore } from "./tile-store";
import type { RasterLayerMask } from "./types";

const W = 64, H = 48;

/** A document-sized buffer, filled so every pixel says where it came from. */
function fill(seed: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const index = (y * W + x) * 4;
    pixels[index] = (x * 3 + seed) % 256; pixels[index + 1] = (y * 5 + seed) % 256;
    pixels[index + 2] = seed; pixels[index + 3] = 255;
  }
  return pixels;
}

describe("a rectangle of pixels, swapped in and out — GIMP's undo record", () => {
  const rect = { x: 10, y: 8, width: 12, height: 9 };

  it("puts back exactly what was there, and comes back holding what it replaced", () => {
    const before = fill(0), after = fill(120);
    const layer = createRasterLayer(W, H, "L");
    setLayerPixels(layer, before, W, H);

    // The edit: the rectangle only, as a tool would have painted it.
    const edited = before.slice();
    for (let y = 0; y < rect.height; y += 1) {
      const from = ((rect.y + y) * W + rect.x) * 4;
      edited.set(after.subarray(from, from + rect.width * 4), from);
    }
    setLayerPixels(layer, edited, W, H);

    // Undo: swap the record in. What comes back is what redo needs.
    const patch = cropRegion(before, W, rect);
    const redo = swapLayerRegion(layer, rect, patch, W, H);
    expect(Array.from(layer.pixels)).toEqual(Array.from(before));
    expect(Array.from(redo)).toEqual(Array.from(cropRegion(after, W, rect)));

    // Redo: the same operation again, which is the whole point of a swap.
    swapLayerRegion(layer, rect, redo, W, H);
    expect(Array.from(layer.pixels)).toEqual(Array.from(edited));
  });

  it("hands the layer a new buffer and bumps pixelsRevision, because either could be the only signal a reader still checks", () => {
    // `layerRenderSignatures` compares `pixelsRevision` now, not `layer.pixels` by identity — the
    // phase 2 migration of docs/master-plan.md §37.6.2 moved every such reader
    // (`layerDocumentPixels`'s cache, `layerOpaqueBounds`'s cache, and three others) off identity.
    // Phase 3 tried retiring the fresh-buffer fallback on the strength of that migration and had
    // to be reverted (see this file's `duplicate-swap-sharing.test.ts` sibling): `duplicateLayer`
    // shares this exact buffer object with a copy without cloning it, safe only as long as nothing
    // ever writes through the shared reference — which writing in place here would do. The
    // original identity-based reason for the fresh buffer is gone, but a second, independent
    // reason (never mutate a possibly-shared buffer) means the fresh buffer stays.
    const layer = createRasterLayer(W, H, "L");
    setLayerPixels(layer, fill(0), W, H);
    const buffer = layer.pixels, revision = layer.pixelsRevision;
    swapLayerRegion(layer, rect, cropRegion(fill(90), W, rect), W, H);
    expect(layer.pixels).not.toBe(buffer);
    expect(layer.pixelsRevision).toBe(revision + 1);
  });

  it("costs the rectangle, not the layer", () => {
    const patch = cropRegion(fill(0), W, rect);
    expect(patch.byteLength).toBe(rect.width * rect.height * 4);
    expect(patch.byteLength).toBeLessThan(W * H * 4 / 10);
  });

  it("shrinks the layer back when undoing the stroke that grew it", () => {
    // A layer holding one opaque dot, then painted far from it: the layer's bounds grow to cover
    // both. Undoing has to give the small bounds back, or the buffer keeps the size of the
    // largest stroke ever made on it.
    const empty = new Uint8ClampedArray(W * H * 4);
    const dot = empty.slice();
    for (let i = 0; i < 4; i += 1) dot[(4 * W + 4) * 4 + i] = 255;
    const layer = createRasterLayer(W, H, "L");
    setLayerPixels(layer, dot, W, H);
    const small = { ...layer.bounds };

    const painted = dot.slice();
    for (let y = 30; y < 40; y += 1) for (let x = 40; x < 50; x += 1) {
      const index = (y * W + x) * 4;
      painted[index] = 200; painted[index + 1] = 30; painted[index + 2] = 30; painted[index + 3] = 255;
    }
    setLayerPixels(layer, painted, W, H);
    expect(layer.bounds.width).toBeGreaterThan(small.width);

    const strokeRect = { x: 40, y: 30, width: 10, height: 10 };
    swapLayerRegion(layer, strokeRect, cropRegion(dot, W, strokeRect), W, H);
    expect(layer.bounds).toEqual(small);
    expect(layer.pixels.length).toBe(small.width * small.height * 4);
  });

  it("grows the layer when the rectangle being restored falls outside it", () => {
    // The mirror case: redoing an erase that had shrunk the layer.
    const empty = new Uint8ClampedArray(W * H * 4);
    const dot = empty.slice();
    for (let i = 0; i < 4; i += 1) dot[(4 * W + 4) * 4 + i] = 255;
    const layer = createRasterLayer(W, H, "L");
    setLayerPixels(layer, dot, W, H);

    const far = { x: 50, y: 40, width: 6, height: 5 };
    const content = new Uint8ClampedArray(far.width * far.height * 4).fill(255);
    swapLayerRegion(layer, far, content, W, H);

    expect(layer.bounds.x + layer.bounds.width).toBeGreaterThanOrEqual(far.x + far.width);
    expect(layer.pixels[((far.y - layer.bounds.y) * layer.bounds.width + (far.x - layer.bounds.x)) * 4 + 3]).toBe(255);
    // The dot it already had is still there, in its new place in the buffer.
    expect(layer.pixels[((4 - layer.bounds.y) * layer.bounds.width + (4 - layer.bounds.x)) * 4 + 3]).toBe(255);
  });

  it("swaps a mask by its own bytes, not by a colour buffer", () => {
    const mask: RasterLayerMask = { tiles: TileStore.fromPixels(new Uint8ClampedArray(W * H).fill(255), W, H, 1), pixelsRevision: 0, enabled: true, linked: true, density: 1, feather: 0 };
    const before = fill(0);
    const patch = cropRegionAsMask(before, W, rect);
    expect(patch.length).toBe(rect.width * rect.height);

    const store = mask.tiles;
    const redo = swapMaskRegion(mask, rect, patch, W, H);
    expect(Array.from(redo)).toEqual(Array.from(new Uint8ClampedArray(rect.width * rect.height).fill(255)));
    expect(mask.tiles.readPixel(rect.x, rect.y)).toEqual([patch[0]]);
    // Outside the rectangle the mask is untouched.
    expect(mask.tiles.readPixel(0, 0)).toEqual([255]);
    // A fresh `TileStore` instance, not the same one — swapMaskRegion clones before writing
    // through it (region-patch.ts's own comment explains why: `duplicateLayer` and
    // `changeRasterDocument` both share a mask's `tiles` object without cloning it, so writing
    // through it directly would corrupt whoever else still holds that reference — the same class
    // of bug `duplicate-swap-sharing.test.ts` catches for a layer's flat buffer). `pixelsRevision`
    // is the change-detection signal `featheredMasks` and `maskScratchByCommitted` read — a
    // separate concern from whether the instance itself is fresh.
    expect(mask.tiles).not.toBe(store);
    expect(mask.pixelsRevision).toBe(1);

    swapMaskRegion(mask, rect, redo, W, H);
    expect(mask.tiles.readPixel(rect.x, rect.y)).toEqual([255]);
    expect(mask.pixelsRevision).toBe(2);
  });
});
