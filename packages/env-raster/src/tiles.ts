import { clampRegionToDocument, compositeRasterRegionWithCheckpoint } from "./render";
import type { RasterRenderCheckpoint } from "./render";
import type { RasterDocumentState, RasterRect } from "./types";

/**
 * Accumulated invalid area.
 *
 * Kept as a handful of rectangles rather than a list of every edit: a brush stroke alone
 * produces hundreds, and intersecting thousands of rectangles per frame costs more than the
 * repaint it saves. Past a small budget the region collapses to its bounding box, which is the
 * standard trade windowing systems make.
 */
export class DirtyRegion {
  readonly #limit: number;
  #rects: RasterRect[] = [];
  #everything = false;

  constructor(limit = 8) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Dirty region limit must be a positive integer");
    this.#limit = limit;
  }

  get isEmpty(): boolean { return !this.#everything && this.#rects.length === 0; }
  get coversEverything(): boolean { return this.#everything; }

  add(rect: RasterRect): void {
    if (this.#everything || rect.width <= 0 || rect.height <= 0) return;
    this.#rects.push({ ...rect });
    if (this.#rects.length > this.#limit) this.#rects = [boundingBox(this.#rects)];
  }

  addEverything(): void {
    this.#everything = true;
    this.#rects = [];
  }

  /** Returns the pending rectangles and resets. `null` means "the whole document". */
  consume(): readonly RasterRect[] | null {
    if (this.#everything) { this.#everything = false; this.#rects = []; return null; }
    const rects = this.#rects;
    this.#rects = [];
    return rects;
  }
}

export function boundingBox(rects: readonly RasterRect[]): RasterRect {
  const left = Math.min(...rects.map((rect) => rect.x)), top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width)), bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export interface RasterTile {
  readonly col: number;
  readonly row: number;
  readonly rect: RasterRect;
  readonly pixels: Uint8ClampedArray;
  /** Samples per pixel of `rect`: 1 at full resolution, 2 at half, and so on. */
  readonly step: number;
}

export interface PendingTile {
  readonly col: number;
  readonly row: number;
  readonly rect: RasterRect;
}

export interface TileCacheOptions {
  readonly tileSize?: number;
  readonly budgetBytes?: number;
}

export interface TileUpdate {
  /** Every tile covering the requested viewport, valid ones included. */
  readonly visible: readonly RasterTile[];
  /** The subset composited during this call — the only ones that need blitting. */
  readonly repainted: readonly RasterTile[];
  /** True when a time budget stopped the pass with tiles still stale. Call again to continue. */
  readonly pending: boolean;
}

export interface TileUpdateOptions {
  /** Subsampling level for the current zoom; see {@link mipForZoom}. */
  readonly mip?: number;
  /**
   * How long this pass may spend compositing, in milliseconds.
   *
   * Without it a committed stroke recomposites every tile it touched inside the handler that
   * released the pointer — measured at 15 ms for ten tiles of a 1920×1080 document, and it grows
   * with the stroke. GIMP does not do that either: `gimp_projection_chunk_render_iteration`
   * renders the invalidated area a chunk at a time from an idle source, and
   * `gimp_chunk_iterator_set_interval` sizes the next chunk from how long the last one actually
   * took. This is the same bargain in its simplest form — take what fits, say that more is left.
   */
  readonly budgetMs?: number;
}

const key = (col: number, row: number, mip: number) => `${col},${row},${mip}`;
const coordinateKey = (col: number, row: number) => `${col},${row}`;

/**
 * How far to subsample for a given zoom.
 *
 * Borrowed from Patchy, whose tile keys carry a mip level beside their
 * coordinates. Compositing at full resolution for a view that then throws
 * fifteen of every sixteen pixels away is most of the cost of looking at a
 * whole document at once: at six percent zoom a 1920x1080 canvas is 115x65 on
 * screen. The step is a power of two so a tile's samples land on the same grid
 * at every level and the cached tiles of one level are never a blurred copy of
 * another's.
 */
export function mipForZoom(zoom: number): number {
  if (!(zoom > 0) || zoom >= 1) return 0;
  return Math.min(4, Math.floor(Math.log2(1 / zoom)));
}

const stepForMip = (mip: number) => 1 << mip;

/**
 * Composited document, cached in fixed tiles and refreshed only where invalidated.
 *
 * Without this the canvas recomposites the whole document on every committed edit, which on a
 * multi-layer 1920×1080 document costs well over a second. Tiles bound that work to what
 * actually changed and to what is actually on screen.
 */
export class RasterTileCache {
  readonly tileSize: number;
  readonly #budgetBytes: number;
  readonly #tiles = new Map<string, RasterTile>();
  /**
   * A resumable layer-stack boundary per tile (docs/master-plan.md §37.3 item 3), keyed the same
   * as `#tiles`. Not touched by `invalidate()` — a checkpoint self-invalidates by comparing layer
   * signatures on the next `update()`, so it needs no spatial bookkeeping of its own, unlike a
   * finished tile's pixels. `checkpoint.output` is the very same array as the finished tile's own
   * `pixels` (set together below), so it costs nothing extra to keep — the only thing this map
   * adds beyond `#tiles` is the small `clippingBaseByParent`/`groupCheckpoints` bookkeeping,
   * currently left out of `#bytes`'s budget accounting as a known, minor simplification.
   */
  readonly #checkpoints = new Map<string, RasterRenderCheckpoint>();
  /** Every cached mip key at one document-tile coordinate. Keeps invalidation O(changed tiles). */
  readonly #keysByCoordinate = new Map<string, Set<string>>();
  readonly #invalid = new Set<string>();
  #bytes = 0;
  #documentWidth = 0;
  #documentHeight = 0;
  /**
   * Bumped by `invalidateAll()`/`reset()` — the two calls that mark "the world moved on, whatever
   * `pendingTiles()` handed out before this point belongs to a stale epoch". `applyComposited`'s
   * optional `expectedGeneration` is compared against this at write time, not at `pendingTiles()`
   * time, so a caller that captured the generation before starting off-thread work (a Worker round
   * trip: `apps/web`'s `updateTilesParallel`) can detect "the cache moved past me" and skip its own
   * write instead of resurrecting a superseded composite as if it were current. Without this, two
   * overlapping bulk-composite requests against the same cache instance (the same `RasterTileCache`
   * ref outlives a remounted canvas) can finish out of order: the older request's `applyComposited`
   * lands after the newer one's, silently overwriting fresh tiles with stale ones and marking them
   * valid (`#invalid.delete`) so nothing ever recomposites them again — exactly the "a piece of the
   * image reverts and stays reverted" class of bug a plain `cancelled` flag on the *caller's* side
   * cannot catch, because the caller only guards the canvas *blit*, not this cache's own mutation.
   */
  #generation = 0;

  constructor(options: TileCacheOptions = {}) {
    this.tileSize = Math.max(16, Math.floor(options.tileSize ?? 256));
    this.#budgetBytes = Math.max(this.tileSize * this.tileSize * 4, options.budgetBytes ?? 256 * 1024 * 1024);
  }

  get size(): number { return this.#tiles.size; }
  /** Exact aggregate of actual mip buffers; updated at cache ownership changes. */
  get bytes(): number { return this.#bytes; }
  /** The cache's current epoch — see `#generation`'s own doc comment. */
  get generation(): number { return this.#generation; }

  invalidateAll(): void {
    this.#generation += 1;
    for (const cacheKey of this.#tiles.keys()) this.#invalid.add(cacheKey);
  }

  invalidate(rect: RasterRect): void {
    // Every level of a covered tile goes stale together: they are all views of
    // the same pixels, and keeping one would show the edit at some zooms only.
    for (const { col, row } of this.#coveringTiles(rect)) {
      // This used to scan every cached key and check a string prefix here.
      // A tiny brush mark on a large document then cost changed×cached tiles,
      // even though only the mip entries at this coordinate can be stale.
      for (const cacheKey of this.#keysByCoordinate.get(coordinateKey(col, row)) ?? []) this.#invalid.add(cacheKey);
    }
  }

  /** Drops everything; used when the document itself is resized or replaced. */
  reset(): void {
    this.#generation += 1;
    this.#tiles.clear();
    this.#checkpoints.clear();
    this.#keysByCoordinate.clear();
    this.#invalid.clear();
    this.#bytes = 0;
  }

  update(state: RasterDocumentState, viewport: RasterRect, mipOrOptions: number | TileUpdateOptions = 0): TileUpdate {
    const options = typeof mipOrOptions === "number" ? { mip: mipOrOptions } : mipOrOptions;
    const mip = options.mip ?? 0;
    const budgetMs = options.budgetMs ?? Infinity;
    if (state.width !== this.#documentWidth || state.height !== this.#documentHeight) {
      this.reset();
      this.#documentWidth = state.width;
      this.#documentHeight = state.height;
    }
    const started = performance.now();
    const visible: RasterTile[] = [];
    const repainted: RasterTile[] = [];
    let pending = false;
    for (const { col, row } of this.#coveringTiles(clampRegionToDocument(state, viewport))) {
      const cacheKey = key(col, row, mip);
      const cached = this.#tiles.get(cacheKey);
      if (cached && !this.#invalid.has(cacheKey)) {
        // Refresh insertion order so tiles on screen are the last to be evicted.
        this.#tiles.delete(cacheKey);
        this.#tiles.set(cacheKey, cached);
        visible.push(cached);
        continue;
      }
      // Out of time: leave this one stale and say so. The caller comes back for it — a stale tile
      // is never handed out as if it were fresh, so the worst a caller can do by ignoring
      // `pending` is show the previous picture in that tile, which is what it was showing anyway.
      if (repainted.length > 0 && performance.now() - started >= budgetMs) { pending = true; continue; }
      const rect = clampRegionToDocument(state, { x: col * this.tileSize, y: row * this.tileSize, width: this.tileSize, height: this.tileSize });
      if (!rect.width || !rect.height) continue;
      const step = stepForMip(mip);
      const result = compositeRasterRegionWithCheckpoint(state, rect, this.#checkpoints.get(cacheKey) ?? null, { step });
      if (result.checkpoint) this.#checkpoints.set(cacheKey, result.checkpoint); else this.#checkpoints.delete(cacheKey);
      const tile: RasterTile = { col, row, rect, pixels: result.pixels, step };
      const replaced = this.#tiles.get(cacheKey);
      this.#tiles.delete(cacheKey);
      this.#tiles.set(cacheKey, tile);
      // A mip level holds its own, smaller buffer. Count those actual bytes,
      // not a full-resolution tile estimate, and do it at insertion so the
      // eviction loop never has to recount the entire cache.
      this.#bytes += tile.pixels.byteLength - (replaced?.pixels.byteLength ?? 0);
      const coordinate = coordinateKey(col, row);
      let coordinateKeys = this.#keysByCoordinate.get(coordinate);
      if (!coordinateKeys) { coordinateKeys = new Set(); this.#keysByCoordinate.set(coordinate, coordinateKeys); }
      coordinateKeys.add(cacheKey);
      this.#invalid.delete(cacheKey);
      visible.push(tile);
      repainted.push(tile);
    }
    this.#evict(new Set(visible.map((tile) => key(tile.col, tile.row, mip))));
    return { visible, repainted, pending };
  }

  /**
   * The planning half of `update()`, split out for docs/master-plan.md §37.3 item 4: which tiles
   * covering `viewport` at `mip` are missing or invalidated, without compositing any of them.
   * `update()` itself must stay synchronous and main-thread (the interactive repaint path this
   * class exists for cannot afford a Worker round trip per frame) — this exists so a caller in
   * `apps/web` that DOES want to composite many tiles off-thread (a freshly mounted canvas with
   * nothing cached yet, `update()`'s own `canvasChanged`/`invalidateAll()` case, not the ordinary
   * small-stroke-repaint case) can compute their pixels itself, in parallel, and hand them back via
   * `applyComposited` — this package still never imports a Worker or touches the DOM to do it.
   */
  pendingTiles(state: RasterDocumentState, viewport: RasterRect, mip = 0): PendingTile[] {
    if (state.width !== this.#documentWidth || state.height !== this.#documentHeight) {
      this.reset();
      this.#documentWidth = state.width;
      this.#documentHeight = state.height;
    }
    const pending: PendingTile[] = [];
    for (const { col, row } of this.#coveringTiles(clampRegionToDocument(state, viewport))) {
      const cacheKey = key(col, row, mip);
      const cached = this.#tiles.get(cacheKey);
      if (cached && !this.#invalid.has(cacheKey)) continue;
      const rect = clampRegionToDocument(state, { x: col * this.tileSize, y: row * this.tileSize, width: this.tileSize, height: this.tileSize });
      if (!rect.width || !rect.height) continue;
      pending.push({ col, row, rect });
    }
    return pending;
  }

  /**
   * Inserts externally-composited tiles (from `pendingTiles`) — the same cache-entry bookkeeping
   * `update()`'s own insertion does (LRU ordering, byte accounting, the coordinate→keys index,
   * clearing invalidation), minus the checkpoint: a checkpoint only exists for a composite this
   * class ran itself through `compositeRasterRegionWithCheckpoint`, so a tile supplied here starts
   * without one. That is correct, not a regression — its *next* `update()` simply recomposites
   * from scratch instead of resuming, exactly as if its checkpoint had been evicted.
   *
   * `expectedGeneration`, when passed, must match `this.generation` (as read by the caller at the
   * same moment it called `pendingTiles()`, before starting the off-thread work `entries` is the
   * result of) or the whole call is a no-op that returns `false` — see `#generation`'s doc comment
   * for the stale-overwrite race this guards against. Omitting it keeps the old unconditional
   * behaviour, for callers (tests, anything single-flight) that have no epoch to compare.
   */
  applyComposited(entries: readonly { col: number; row: number; rect: RasterRect; pixels: Uint8ClampedArray; step: number }[], mip = 0, expectedGeneration?: number): boolean {
    if (expectedGeneration !== undefined && expectedGeneration !== this.#generation) return false;
    for (const entry of entries) {
      const cacheKey = key(entry.col, entry.row, mip);
      const tile: RasterTile = { col: entry.col, row: entry.row, rect: entry.rect, pixels: entry.pixels, step: entry.step };
      const replaced = this.#tiles.get(cacheKey);
      this.#tiles.delete(cacheKey);
      this.#tiles.set(cacheKey, tile);
      this.#checkpoints.delete(cacheKey);
      this.#bytes += tile.pixels.byteLength - (replaced?.pixels.byteLength ?? 0);
      const coordinate = coordinateKey(entry.col, entry.row);
      let coordinateKeys = this.#keysByCoordinate.get(coordinate);
      if (!coordinateKeys) { coordinateKeys = new Set(); this.#keysByCoordinate.set(coordinate, coordinateKeys); }
      coordinateKeys.add(cacheKey);
      this.#invalid.delete(cacheKey);
    }
    // Eviction is intentionally left to the next `update()` call: that is the one place that
    // already knows the true current viewport's protected set, and calling it is not optional for
    // this class's own interactive path (every revision runs it), so there is no risk of the
    // budget growing unchecked between an `applyComposited` call and the next `update()`.
    return true;
  }

  *#coveringTiles(rect: RasterRect): Generator<{ col: number; row: number }> {
    if (rect.width <= 0 || rect.height <= 0) return;
    const firstCol = Math.floor(rect.x / this.tileSize), lastCol = Math.floor((rect.x + rect.width - 1) / this.tileSize);
    const firstRow = Math.floor(rect.y / this.tileSize), lastRow = Math.floor((rect.y + rect.height - 1) / this.tileSize);
    for (let row = Math.max(0, firstRow); row <= lastRow; row += 1) for (let col = Math.max(0, firstCol); col <= lastCol; col += 1) yield { col, row };
  }

  #evict(protectedKeys: ReadonlySet<string>): void {
    for (const cacheKey of this.#tiles.keys()) {
      if (this.bytes <= this.#budgetBytes) return;
      if (protectedKeys.has(cacheKey)) continue;
      const tile = this.#tiles.get(cacheKey);
      this.#tiles.delete(cacheKey);
      this.#checkpoints.delete(cacheKey);
      if (tile) {
        this.#bytes -= tile.pixels.byteLength;
        const coordinate = coordinateKey(tile.col, tile.row);
        const keys = this.#keysByCoordinate.get(coordinate);
        keys?.delete(cacheKey);
        if (keys?.size === 0) this.#keysByCoordinate.delete(coordinate);
      }
      this.#invalid.delete(cacheKey);
    }
  }
}
