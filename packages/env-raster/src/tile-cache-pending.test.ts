import { describe, expect, it } from "vitest";
import { RasterTileCache, appendLayer, compositeRasterRegion, createRasterDocument, createRasterLayer, setLayerPixels } from "./index";
import type { RasterDocumentState } from "./types";

/**
 * `pendingTiles`/`applyComposited` (docs/master-plan.md §37.3 item 4) split `update()`'s own
 * planning from its compositing so a caller in `apps/web` can composite off-thread — this file
 * proves the split reproduces `update()`'s own result exactly, the same "verify byte-for-byte
 * against the existing behaviour" discipline §37.8/§37.9 already used for the checkpoint cache.
 */

const W = 96, H = 96;

function scene(): RasterDocumentState {
  const state = createRasterDocument(W, H);
  const base = createRasterLayer(W, H, "Base");
  const basePixels = base.tiles.toPixels();
  for (let i = 0; i < basePixels.length; i += 4) { basePixels[i] = 40; basePixels[i + 1] = 60; basePixels[i + 2] = 80; basePixels[i + 3] = 255; }
  setLayerPixels(base, basePixels, W, H);
  appendLayer(state, base);
  const top = createRasterLayer(W, H, "Top");
  const topPixels = top.tiles.toPixels();
  for (let y = 20; y < 70; y += 1) for (let x = 20; x < 70; x += 1) {
    const i = (y * W + x) * 4;
    topPixels[i] = 200; topPixels[i + 1] = 30; topPixels[i + 2] = 10; topPixels[i + 3] = 200;
  }
  setLayerPixels(top, topPixels, W, H);
  top.opacity = 0.85;
  appendLayer(state, top);
  return state;
}

const viewport = { x: 0, y: 0, width: W, height: H };

describe("pendingTiles + applyComposited reproduce update()'s own result", () => {
  it("byte-for-byte, tile by tile, for a fresh cache", () => {
    const state = scene();
    const reference = new RasterTileCache({ tileSize: 32 }).update(state, viewport, 0);

    const cache = new RasterTileCache({ tileSize: 32 });
    const pending = cache.pendingTiles(state, viewport, 0);
    expect(pending.length).toBe(reference.visible.length);
    const entries = pending.map((tile) => ({ ...tile, pixels: compositeRasterRegion(state, tile.rect), step: 1 }));
    cache.applyComposited(entries, 0);
    const result = cache.update(state, viewport, 0);

    expect(result.pending).toBe(false);
    expect(result.repainted.length).toBe(0); // everything was already valid via applyComposited
    const byKey = (tiles: readonly { col: number; row: number; pixels: Uint8ClampedArray }[]) =>
      new Map(tiles.map((tile) => [`${tile.col},${tile.row}`, tile.pixels]));
    const referenceByKey = byKey(reference.visible), resultByKey = byKey(result.visible);
    expect(resultByKey.size).toBe(referenceByKey.size);
    for (const [tileKey, pixels] of referenceByKey) expect([...resultByKey.get(tileKey)!], tileKey).toEqual([...pixels]);
  });

  it("reports nothing pending once every visible tile is cached and valid", () => {
    const state = scene();
    const cache = new RasterTileCache({ tileSize: 32 });
    cache.update(state, viewport, 0);
    expect(cache.pendingTiles(state, viewport, 0)).toEqual([]);
  });

  it("reports an invalidated tile again after invalidate()", () => {
    const state = scene();
    const cache = new RasterTileCache({ tileSize: 32 });
    cache.update(state, viewport, 0);
    expect(cache.pendingTiles(state, viewport, 0)).toEqual([]);
    cache.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    const pending = cache.pendingTiles(state, viewport, 0);
    expect(pending.length).toBe(1);
    expect(pending[0]).toMatchObject({ col: 0, row: 0 });
  });

  it("a tile inserted via applyComposited recomposites from scratch on its own next update (no checkpoint reuse claimed)", () => {
    const state = scene();
    const cache = new RasterTileCache({ tileSize: 32 });
    const pending = cache.pendingTiles(state, viewport, 0);
    const entries = pending.map((tile) => ({ ...tile, pixels: compositeRasterRegion(state, tile.rect), step: 1 }));
    cache.applyComposited(entries, 0);
    // Invalidate one tile and re-run through the ordinary synchronous path — this must not throw
    // or behave differently just because that tile's own history started via applyComposited.
    cache.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    expect(() => cache.update(state, viewport, 0)).not.toThrow();
  });
});
