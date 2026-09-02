import { clampRegionToDocument, compositeRasterRegion } from "./render";
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

export function rectsIntersect(a: RasterRect, b: RasterRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export interface RasterTile {
  readonly col: number;
  readonly row: number;
  readonly rect: RasterRect;
  readonly pixels: Uint8ClampedArray;
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
}

const key = (col: number, row: number) => `${col},${row}`;

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
  readonly #invalid = new Set<string>();
  #documentWidth = 0;
  #documentHeight = 0;

  constructor(options: TileCacheOptions = {}) {
    this.tileSize = Math.max(16, Math.floor(options.tileSize ?? 256));
    this.#budgetBytes = Math.max(this.tileSize * this.tileSize * 4, options.budgetBytes ?? 256 * 1024 * 1024);
  }

  get size(): number { return this.#tiles.size; }
  get bytes(): number { return this.#tiles.size * this.tileSize * this.tileSize * 4; }

  invalidateAll(): void {
    for (const cacheKey of this.#tiles.keys()) this.#invalid.add(cacheKey);
  }

  invalidate(rect: RasterRect): void {
    for (const { col, row } of this.#coveringTiles(rect)) {
      const cacheKey = key(col, row);
      if (this.#tiles.has(cacheKey)) this.#invalid.add(cacheKey);
    }
  }

  /** Drops everything; used when the document itself is resized or replaced. */
  reset(): void {
    this.#tiles.clear();
    this.#invalid.clear();
  }

  update(state: RasterDocumentState, viewport: RasterRect): TileUpdate {
    if (state.width !== this.#documentWidth || state.height !== this.#documentHeight) {
      this.reset();
      this.#documentWidth = state.width;
      this.#documentHeight = state.height;
    }
    const visible: RasterTile[] = [];
    const repainted: RasterTile[] = [];
    for (const { col, row } of this.#coveringTiles(clampRegionToDocument(state, viewport))) {
      const cacheKey = key(col, row);
      const cached = this.#tiles.get(cacheKey);
      if (cached && !this.#invalid.has(cacheKey)) {
        // Refresh insertion order so tiles on screen are the last to be evicted.
        this.#tiles.delete(cacheKey);
        this.#tiles.set(cacheKey, cached);
        visible.push(cached);
        continue;
      }
      const rect = clampRegionToDocument(state, { x: col * this.tileSize, y: row * this.tileSize, width: this.tileSize, height: this.tileSize });
      if (!rect.width || !rect.height) continue;
      const tile: RasterTile = { col, row, rect, pixels: compositeRasterRegion(state, rect) };
      this.#tiles.delete(cacheKey);
      this.#tiles.set(cacheKey, tile);
      this.#invalid.delete(cacheKey);
      visible.push(tile);
      repainted.push(tile);
    }
    this.#evict(new Set(visible.map((tile) => key(tile.col, tile.row))));
    return { visible, repainted };
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
      this.#tiles.delete(cacheKey);
      this.#invalid.delete(cacheKey);
    }
  }
}
