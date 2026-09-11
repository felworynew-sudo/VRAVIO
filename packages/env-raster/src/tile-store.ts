import type { RasterRect } from "./types";

/**
 * docs/master-plan.md §37.3 item 1, step 1 of 3 (§37.5's own plan for this section): the
 * tile-grained copy-on-write primitive, built and tested standalone before anything in
 * `RasterLayer` is asked to use it. `layer-ops.ts`'s `duplicateLayer` (§37.5, commit 822e91c)
 * already gets copy-on-write for a *whole* layer by sharing its one `Uint8ClampedArray`
 * reference — correct, and free, because nothing in this package ever mutates a shared pixels
 * array in place. This is the next size down: Krita's actual `KisTileData` trade
 * (`kis_tile.h`/`kis_tiled_data_manager.h`), where a *clone* of a store and a single small write
 * into it only pay for the tiles the write actually touches, not the whole layer — the case
 * whole-buffer sharing cannot help with, because one write anywhere still means a full
 * materialize-and-crop today.
 *
 * Not yet wired into `RasterLayer`/`layer-bounds.ts` — that is step 2, and deliberately kept
 * separate so this primitive's own correctness (the part a subtle bug would be easy to hide
 * inside) is settled first, against nothing but itself.
 */

/** Krita's own tile edge (`kis_tile.h`'s `KisTile::WIDTH`/`HEIGHT`) — 64x64 is small enough that
 *  a brush dab touches only a handful of tiles, large enough that the tile-map bookkeeping
 *  itself stays cheap relative to what a tile holds (64*64*4 = 16KB per full tile). */
export const TILE_SIZE = 64;

const key = (col: number, row: number) => col * 0x10000 + row;

/** One tile's own rectangle within the store, clamped to the store's bounds — the tiles along
 *  the right/bottom edge are smaller than `TILE_SIZE` rather than padded, the same convention
 *  `tiles.ts`'s `RasterTileCache` already uses for the identical reason (no invented pixels to
 *  keep meaningless, and `width * height * 4` stays the buffer's real length always). */
function tileRect(col: number, row: number, width: number, height: number): RasterRect {
  const x = col * TILE_SIZE, y = row * TILE_SIZE;
  return { x, y, width: Math.min(TILE_SIZE, width - x), height: Math.min(TILE_SIZE, height - y) };
}

/**
 * A pixel buffer split into fixed-size tiles, cloned in O(tile count) and written to in
 * O(tiles touched) rather than O(width × height) either way.
 *
 * The copy-on-write trade is structural, not reference-counted: `clone()` shares this store's
 * tile map by reference, and `writeRegion` never mutates a tile array in place — it always
 * builds a fresh one and replaces the map entry, the exact discipline `layer-bounds.ts`'s
 * `setLayerPixels` already holds for whole layers (CLAUDE.md §4's "единственная дверь"). Two
 * stores that share a tile because one was cloned from the other therefore can never see each
 * other's writes, with no bookkeeping needed to know whether the tile is "actually" shared at
 * the moment of the write — cheaper to always replace than to ask.
 */
export class TileStore {
  readonly width: number;
  readonly height: number;
  readonly #tiles: Map<number, Uint8ClampedArray>;

  private constructor(width: number, height: number, tiles: Map<number, Uint8ClampedArray>) {
    this.width = width;
    this.height = height;
    this.#tiles = tiles;
  }

  /** Builds a store from a flat, document/layer-shaped buffer — one crop per tile. */
  static fromPixels(pixels: Uint8ClampedArray, width: number, height: number): TileStore {
    if (pixels.length !== width * height * 4) throw new RangeError("TileStore.fromPixels: buffer length does not match width*height*4");
    const tiles = new Map<number, Uint8ClampedArray>();
    const columns = Math.ceil(width / TILE_SIZE), rows = Math.ceil(height / TILE_SIZE);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const rect = tileRect(col, row, width, height);
        const tile = new Uint8ClampedArray(rect.width * rect.height * 4);
        for (let y = 0; y < rect.height; y += 1) {
          const from = ((rect.y + y) * width + rect.x) * 4;
          tile.set(pixels.subarray(from, from + rect.width * 4), y * rect.width * 4);
        }
        tiles.set(key(col, row), tile);
      }
    }
    return new TileStore(width, height, tiles);
  }

  /** An all-transparent store of the given size — every tile allocated (not sparse), so a
   *  freshly created layer costs one real materialize either way; sparse-on-read is a later
   *  optimisation this constructor deliberately leaves for when a real caller needs it. */
  static empty(width: number, height: number): TileStore {
    return TileStore.fromPixels(new Uint8ClampedArray(width * height * 4), width, height);
  }

  /** O(tile count): copies the *map*, not the tiles it points to. The two stores diverge only
   *  where either one is actually written to afterward. */
  clone(): TileStore {
    return new TileStore(this.width, this.height, new Map(this.#tiles));
  }

  /** Rebuilds one flat buffer — the escape hatch every existing consumer that still thinks in
   *  `Uint8ClampedArray` needs, the same role `layerDocumentPixels` already plays for
   *  bounds-cropped layers. */
  toPixels(): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(this.width * this.height * 4);
    const columns = Math.ceil(this.width / TILE_SIZE), rows = Math.ceil(this.height / TILE_SIZE);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const tile = this.#tiles.get(key(col, row));
        if (!tile) continue;
        const rect = tileRect(col, row, this.width, this.height);
        for (let y = 0; y < rect.height; y += 1) {
          const from = y * rect.width * 4;
          pixels.set(tile.subarray(from, from + rect.width * 4), ((rect.y + y) * this.width + rect.x) * 4);
        }
      }
    }
    return pixels;
  }

  /** One pixel's RGBA, without materialising anything — `layerAlphaAt`'s reason to exist,
   *  generalised to all four channels for a tiled store. Out-of-bounds reads as transparent
   *  black, the same convention `layerAlphaAt` uses. */
  readPixel(x: number, y: number): readonly [number, number, number, number] {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return [0, 0, 0, 0];
    const col = Math.floor(x / TILE_SIZE), row = Math.floor(y / TILE_SIZE);
    const tile = this.#tiles.get(key(col, row));
    if (!tile) return [0, 0, 0, 0];
    const rect = tileRect(col, row, this.width, this.height);
    const index = ((y - rect.y) * rect.width + (x - rect.x)) * 4;
    return [tile[index]!, tile[index + 1]!, tile[index + 2]!, tile[index + 3]!];
  }

  /**
   * Writes a document/layer-shaped `source` buffer into `rect`, touching only the tiles `rect`
   * overlaps. Each touched tile is replaced wholesale with a freshly built one that merges the
   * tile's own untouched pixels with `source`'s — never mutated in place, so a clone sharing
   * that same tile array is unaffected (CLAUDE.md §4's invariant, at tile granularity).
   *
   * `source` is store-shaped (`sourceWidth` wide, read at the *same* absolute `x`/`y` `rect`
   * names), not `rect`-shaped — the same convention `cropToRect(pixels, documentWidth, rect)`
   * already uses throughout `layer-bounds.ts`. Every existing caller of `setLayerPixels`
   * materialises to full canvas size before calling it; a caller migrating a hinted edit from
   * that flat-buffer path can hand this the very same buffer and `edit.bounds`, with no crop
   * step of its own to write first.
   */
  writeRegion(rect: RasterRect, source: Uint8ClampedArray, sourceWidth: number): void {
    const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
    const right = Math.min(this.width, rect.x + rect.width), bottom = Math.min(this.height, rect.y + rect.height);
    if (right <= left || bottom <= top) return;
    const firstCol = Math.floor(left / TILE_SIZE), lastCol = Math.floor((right - 1) / TILE_SIZE);
    const firstRow = Math.floor(top / TILE_SIZE), lastRow = Math.floor((bottom - 1) / TILE_SIZE);
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let col = firstCol; col <= lastCol; col += 1) {
        const tileArea = tileRect(col, row, this.width, this.height);
        const existing = this.#tiles.get(key(col, row));
        const next = existing ? existing.slice() : new Uint8ClampedArray(tileArea.width * tileArea.height * 4);
        const writeLeft = Math.max(left, tileArea.x), writeTop = Math.max(top, tileArea.y);
        const writeRight = Math.min(right, tileArea.x + tileArea.width), writeBottom = Math.min(bottom, tileArea.y + tileArea.height);
        for (let y = writeTop; y < writeBottom; y += 1) {
          const fromSource = (y * sourceWidth + writeLeft) * 4;
          const toTile = ((y - tileArea.y) * tileArea.width + (writeLeft - tileArea.x)) * 4;
          next.set(source.subarray(fromSource, fromSource + (writeRight - writeLeft) * 4), toTile);
        }
        this.#tiles.set(key(col, row), next);
      }
    }
  }

  /** Bytes held by tiles unique to this store — `seen` lets a caller price several clones
   *  together the same way `accumulateUniquePixelBytes` prices layers sharing whole buffers. */
  uniqueBytes(seen: Set<Uint8ClampedArray>): number {
    let bytes = 0;
    for (const tile of this.#tiles.values()) {
      if (seen.has(tile)) continue;
      seen.add(tile);
      bytes += tile.byteLength;
    }
    return bytes;
  }
}
