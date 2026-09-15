import { describe, expect, it } from "vitest";
import { createRasterDocument, createRasterLayerMask, duplicateLayer, setLayerPixels } from "./index";
import { swapLayerRegion, swapMaskRegion } from "./region-patch";
import { TileStore } from "./tile-store";

/**
 * `layer-ops.ts`'s `duplicateLayer` (docs/master-plan.md §37.5, commit 822e91c) shares a layer's
 * `pixels` buffer object with its duplicate rather than copying it, safe only because — per its
 * own doc comment — "no path in this package ever mutates a layer's pixels/mask.pixels array in
 * place". That promise was never actually kept: `region-patch.ts`'s `swapLayerRegion` always
 * wrote a stroke's undo/redo patch straight into `layer.pixels` via `.set(...)` and *only
 * afterwards* checked whether it needed to hand back a fresh object — a check that existed for an
 * unrelated reason (giving identity-comparison caches a changed object to compare against) and
 * happened to run too late to matter here, since the shared buffer had already been written
 * through by the time it ran. This predates §37.6.2 entirely; it surfaced while double-checking
 * that phase 3 of that migration (which tried removing the now-pointless-looking fallback
 * entirely) hadn't broken something — it hadn't, because there was nothing correct left to break.
 * Fixed by moving the copy to before the write loop instead of after, in both the phase-3 attempt
 * and this pre-existing version alike.
 */
describe("swapLayerRegion must not corrupt a buffer duplicateLayer is still sharing", () => {
  it("leaves the duplicate's pixels untouched when the source layer's region is swapped", () => {
    const state = createRasterDocument(32, 32);
    const source = state.layers[0]!;
    // Give the layer real, scannable content so `duplicateLayer`'s share actually starts from a
    // buffer both layers will read, not two empty ones that happen to look alike.
    const original = source.pixels.slice();
    for (let i = 0; i < original.length; i += 4) { original[i] = 10; original[i + 1] = 20; original[i + 2] = 30; original[i + 3] = 255; }
    setLayerPixels(source, original, state.width, state.height);

    const copy = duplicateLayer(state, source.id)!;
    expect(copy.pixels).toBe(source.pixels); // the whole-layer share this test exists to protect

    const rect = { x: 4, y: 4, width: 8, height: 8 };
    const patch = new Uint8ClampedArray(rect.width * rect.height * 4).fill(200);
    for (let i = 3; i < patch.length; i += 4) patch[i] = 255;
    // The buffer both layers are still sharing gets swapped on the *source* — exactly the shape
    // of a stroke's undo/redo running on a layer that was duplicated since the stroke was made.
    swapLayerRegion(source, rect, patch, state.width, state.height);

    // The duplicate must still read the original content, byte for byte, everywhere —
    // including the very rectangle the source just had swapped.
    for (let y = 0; y < copy.bounds.height; y += 1) {
      for (let x = 0; x < copy.bounds.width; x += 1) {
        const index = (y * copy.bounds.width + x) * 4;
        expect(copy.pixels[index]).toBe(10);
        expect(copy.pixels[index + 1]).toBe(20);
        expect(copy.pixels[index + 2]).toBe(30);
        expect(copy.pixels[index + 3]).toBe(255);
      }
    }
  });

  it("leaves the duplicate's mask untouched when the source layer's mask region is swapped", () => {
    // `swapMaskRegion` never had the ordering bug `swapLayerRegion` had — even before
    // §37.6.3's TileStore migration, it built its patched buffer as a separate copy and only
    // reassigned `mask.pixels` at the end, never writing through the original. After the
    // migration, `mask.tiles.clone()` before `writeLocalRegion` is the same discipline at tile
    // granularity — but nothing here had actually said so until this test did.
    const state = createRasterDocument(32, 32);
    const source = state.layers[0]!;
    source.mask = createRasterLayerMask(state.width, state.height);
    source.mask.tiles = TileStore.fromPixels(new Uint8ClampedArray(state.width * state.height).fill(128), state.width, state.height, 1);

    const copy = duplicateLayer(state, source.id)!;
    expect(copy.mask!.tiles).toBe(source.mask.tiles);

    const rect = { x: 4, y: 4, width: 8, height: 8 };
    const patch = new Uint8ClampedArray(rect.width * rect.height).fill(0);
    swapMaskRegion(source.mask, rect, patch, state.width, state.height);

    const copyPixels = copy.mask!.tiles.toPixels();
    for (let i = 0; i < copyPixels.length; i += 1) expect(copyPixels[i]).toBe(128);
  });
});
