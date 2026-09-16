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

  /**
   * `apps/web/src/raster-bulk-composite.ts`'s `updateTilesParallel` reads `cache.generation`
   * before starting its (slow, off-thread) work and hands it back to `applyComposited` as
   * `expectedGeneration` once the work finishes — this is the actual fix for the race a live
   * migration-review pass on §37.3 flagged: two overlapping bulk-composite requests against the
   * same cache instance (two canvas remounts close together) can resolve out of order, and the
   * older one's write must not be allowed to overwrite the newer one's already-current tiles.
   */
  describe("applyComposited's generation guard rejects a stale write", () => {
    it("applies when the passed generation still matches the cache's current one", () => {
      const state = scene();
      const cache = new RasterTileCache({ tileSize: 32 });
      const pending = cache.pendingTiles(state, viewport, 0);
      const generation = cache.generation;
      const entries = pending.map((tile) => ({ ...tile, pixels: compositeRasterRegion(state, tile.rect), step: 1 }));
      expect(cache.applyComposited(entries, 0, generation)).toBe(true);
      expect(cache.pendingTiles(state, viewport, 0)).toEqual([]);
    });

    it("is a no-op once invalidateAll() has moved the cache to a newer generation", () => {
      const state = scene();
      const cache = new RasterTileCache({ tileSize: 32 });
      // Simulate the first (stale) request: capture its epoch, then something else invalidates
      // everything — a second canvas remount — before this request's off-thread work resolves.
      const pending = cache.pendingTiles(state, viewport, 0);
      const staleGeneration = cache.generation;
      const staleEntries = pending.map((tile) => ({ ...tile, pixels: compositeRasterRegion(state, tile.rect), step: 1 }));

      cache.invalidateAll(); // the second, newer request's own remount handling
      // The newer request finishes first and writes fresh tiles at the new generation.
      const freshGeneration = cache.generation;
      const freshEntries = cache.pendingTiles(state, viewport, 0).map((tile) => ({ ...tile, pixels: compositeRasterRegion(state, tile.rect), step: 1 }));
      expect(cache.applyComposited(freshEntries, 0, freshGeneration)).toBe(true);

      // The stale (first) request's write finally resolves — it must be rejected, not silently
      // resurrect the tiles the fresh request just wrote and mark them valid again.
      expect(cache.applyComposited(staleEntries, 0, staleGeneration)).toBe(false);
      expect(cache.pendingTiles(state, viewport, 0)).toEqual([]); // still fully covered by the fresh write, untouched by the stale one
    });
  });
});
