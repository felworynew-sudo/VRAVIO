import { describe, expect, it } from "vitest";
import { WorkerPool } from "@vravio/kernel";
import { RasterTileCache, appendLayer, blendSimpleLayerStack, compositeRasterRegion, createRasterDocument, createRasterGroup, createRasterLayer, setLayerPixels } from "@vravio/env-raster";
import type { RasterDocumentState } from "@vravio/env-raster";
import { MIN_TILES_FOR_PARALLEL_COMPOSITE, updateTilesParallel } from "./raster-bulk-composite";
import type { CompositeBlendInput } from "./composite-worker-pool";

const W = 128, H = 128;

function scene(): RasterDocumentState {
  const state = createRasterDocument(W, H);
  const base = createRasterLayer(W, H, "Base");
  const basePixels = base.tiles.toPixels();
  for (let i = 0; i < basePixels.length; i += 4) { basePixels[i] = 50; basePixels[i + 1] = 70; basePixels[i + 2] = 90; basePixels[i + 3] = 255; }
  setLayerPixels(base, basePixels, W, H);
  appendLayer(state, base);
  const top = createRasterLayer(W, H, "Top");
  const topPixels = top.tiles.toPixels();
  for (let y = 10; y < 100; y += 1) for (let x = 10; x < 100; x += 1) {
    const i = (y * W + x) * 4;
    topPixels[i] = 220; topPixels[i + 1] = 40; topPixels[i + 2] = 15; topPixels[i + 3] = 210;
  }
  setLayerPixels(top, topPixels, W, H);
  top.opacity = 0.7;
  top.blendMode = "multiply";
  appendLayer(state, top);
  return state;
}

/** Real `blendSimpleLayerStack` running in-process — same pattern `composite-worker-pool.test.ts`
 *  uses, proving dispatch through the real `WorkerPool` reproduces the direct call exactly. */
function realCompositePool(size: number) {
  return new WorkerPool<CompositeBlendInput, Uint8ClampedArray>(
    () => ({ run: async (input) => blendSimpleLayerStack(input.width, input.height, input.layers, input.documentX, input.documentY), dispose: () => {} }),
    size,
  );
}

const viewport = { x: 0, y: 0, width: W, height: H };

describe("updateTilesParallel", () => {
  it("fills every visible tile with the same pixels the synchronous compositor would produce", async () => {
    const state = scene();
    const tiles = new RasterTileCache({ tileSize: 32 });
    const ran = await updateTilesParallel(tiles, state, viewport, 0, realCompositePool(4));
    expect(ran).toBe(true);

    const reference = new RasterTileCache({ tileSize: 32 }).update(state, viewport, 0);
    const result = tiles.update(state, viewport, 0);
    expect(result.pending).toBe(false);
    expect(result.repainted.length).toBe(0);
    const byKey = (list: readonly { col: number; row: number; pixels: Uint8ClampedArray }[]) => new Map(list.map((tile) => [`${tile.col},${tile.row}`, tile.pixels]));
    const referenceByKey = byKey(reference.visible), resultByKey = byKey(result.visible);
    expect(resultByKey.size).toBe(referenceByKey.size);
    for (const [tileKey, pixels] of referenceByKey) expect([...resultByKey.get(tileKey)!], tileKey).toEqual([...pixels]);
  });

  it("declines (returns false) when the stack has a group, leaving the cache untouched", async () => {
    const state = scene();
    appendLayer(state, createRasterGroup(W, H, "Group"));
    const tiles = new RasterTileCache({ tileSize: 32 });
    const ran = await updateTilesParallel(tiles, state, viewport, 0, realCompositePool(4));
    expect(ran).toBe(false);
    expect(tiles.pendingTiles(state, viewport, 0).length).toBeGreaterThan(0);
  });

  it("declines when there are too few pending tiles to be worth dispatching", async () => {
    const state = scene();
    const tiles = new RasterTileCache({ tileSize: 256 }); // one tile covers the whole document
    const ran = await updateTilesParallel(tiles, state, viewport, 0, realCompositePool(4));
    expect(ran).toBe(false);
    expect(tiles.pendingTiles(state, viewport, 0).length).toBeLessThan(MIN_TILES_FOR_PARALLEL_COMPOSITE);
  });

  it("declines for a non-zero mip (no step/subsampling support in the fast path)", async () => {
    const state = scene();
    const tiles = new RasterTileCache({ tileSize: 32 });
    const ran = await updateTilesParallel(tiles, state, viewport, 1, realCompositePool(4));
    expect(ran).toBe(false);
  });

  it("matches compositeRasterRegion for the awkward multiply/partial-opacity/partial-alpha case this fixture exercises", async () => {
    const state = scene();
    const tiles = new RasterTileCache({ tileSize: 32 });
    await updateTilesParallel(tiles, state, viewport, 0, realCompositePool(4));
    const result = tiles.update(state, viewport, 0);
    const whole = compositeRasterRegion(state, viewport);
    for (const tile of result.visible) {
      for (let y = 0; y < tile.rect.height; y += 1) for (let x = 0; x < tile.rect.width; x += 1) {
        const tileIndex = (y * tile.rect.width + x) * 4;
        const wholeIndex = ((tile.rect.y + y) * W + (tile.rect.x + x)) * 4;
        expect(tile.pixels[tileIndex]).toBe(whole[wholeIndex]);
        expect(tile.pixels[tileIndex + 3]).toBe(whole[wholeIndex + 3]);
      }
    }
  });
});
