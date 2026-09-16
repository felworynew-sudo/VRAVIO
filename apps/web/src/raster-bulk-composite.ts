import { TileJobScheduler, isSimpleLayerStack, layerDocumentPixels, flattenRasterLayers, isLayerEffectivelyVisible, effectiveLayerOpacity, type RasterDocumentState, type RasterTileCache, type RasterRect } from "@vravio/env-raster";
import { WorkerPool } from "@vravio/kernel";
import { compositeWorkerPool, dispatchTileBlendJobs, type CompositeBlendInput, type TileBlendJob } from "./composite-worker-pool";

/**
 * Bulk, off-main-thread tile recompute — docs/master-plan.md §37.3 item 4's one safely-scoped real
 * consumer. Targets exactly the case `raster-commit.ts`'s own `canvasChanged`/`invalidateAll()`
 * path hits: a freshly mounted canvas with nothing cached, where every visible tile needs a full
 * fresh composite at once (the "105 ms for 60 layers" cost §37.9 already measured for an uncached
 * recompute). Never the interactive stroke-repaint path — that stays exactly as synchronous as it
 * is today; see `composite-worker-pool.ts`'s own doc comment for why a Worker round trip has no
 * place in that loop. Falls back to `false` (caller keeps using the ordinary synchronous
 * `RasterTileCache.update()`) whenever the stack has anything this fast path does not cover
 * (`isSimpleLayerStack`) or there simply aren't enough pending tiles to be worth dispatching.
 */
export const MIN_TILES_FOR_PARALLEL_COMPOSITE = 4;

/**
 * Attempts a parallel bulk recompute of every currently-pending tile in `viewport`. Returns `true`
 * if it ran (the cache is now up to date for `viewport`/`mip`, the caller should blit and skip its
 * own synchronous `update()` for this pass) or `false` if it declined (the caller should fall back
 * to `RasterTileCache.update()` unchanged).
 */
export async function updateTilesParallel(
  tiles: RasterTileCache,
  state: RasterDocumentState,
  viewport: RasterRect,
  mip: number,
  pool: WorkerPool<CompositeBlendInput, Uint8ClampedArray> = compositeWorkerPool(),
): Promise<boolean> {
  // `blendSimpleLayerStack` has no notion of `step` (mip subsampling) — a reduced-resolution tile
  // needs a larger source rect composited down to a smaller output, which only
  // `compositeRasterRegionWithCheckpoint`'s own `step` handling does today. Zoomed-out bulk opens
  // fall back to the ordinary synchronous path rather than silently mis-sizing a mip tile.
  if (mip !== 0) return false;
  if (!isSimpleLayerStack(state)) return false;
  const pending = tiles.pendingTiles(state, viewport, mip);
  if (pending.length < MIN_TILES_FOR_PARALLEL_COMPOSITE) return false;
  // Captured *before* the Worker round trip below, which is the only slow step here: a second,
  // overlapping call against this same `tiles` instance (two canvas remounts close enough together
  // that the first's dispatch is still in flight when the second starts) bumps the cache's
  // generation via its own `invalidateAll()`. `applyComposited`'s `expectedGeneration` check then
  // refuses this call's write once it finally resolves, instead of overwriting the second call's
  // already-composited, already-current tiles with this stale run's — see `RasterTileCache`'s own
  // `#generation` doc comment for the corruption this prevents.
  const generation = tiles.generation;

  const visibleLayers = flattenRasterLayers(state.layers).filter(
    (layer) => isLayerEffectivelyVisible(layer, state.layers) && effectiveLayerOpacity(layer, state.layers) > 0,
  );
  const scheduler = new TileJobScheduler();
  const jobs: TileBlendJob[] = pending.map((tile) => ({
    id: `${tile.col},${tile.row}`,
    sequentiality: "concurrent",
    input: {
      width: tile.rect.width,
      height: tile.rect.height,
      documentX: tile.rect.x,
      documentY: tile.rect.y,
      layers: visibleLayers.map((layer) => ({
        pixels: layerDocumentPixels(layer, state.width, state.height, tile.rect),
        opacity: effectiveLayerOpacity(layer, state.layers) * (layer.fillOpacity ?? 1),
        blendMode: layer.blendMode,
      })),
    },
  }));
  const results = await dispatchTileBlendJobs(pool, scheduler, jobs);
  const step = 1 << mip;
  return tiles.applyComposited(pending.map((tile, index) => ({ ...tile, pixels: results[index]!, step })), mip, generation);
}
