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
 *  itself stays cheap relative to what a tile holds (64*64*4 = 16KB per full RGBA tile). */
export const TILE_SIZE = 64;

const key = (col: number, row: number) => col * 0x10000 + row;

/** One tile's own rectangle within the store, clamped to the store's bounds — the tiles along
 *  the right/bottom edge are smaller than `TILE_SIZE` rather than padded, the same convention
 *  `tiles.ts`'s `RasterTileCache` already uses for the identical reason (no invented pixels to
 *  keep meaningless, and `width * height * channels` stays the buffer's real length always). */
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
 *
 * A `TileStore` instance itself is *not* one of the immutable, freely-shareable things this
 * class produces: `writeRegion` mutates this store's own tile map in place (`Map.set`). Two
 * owners (a layer and its `duplicateLayer` copy, a document and a history snapshot) may safely
 * share one *reference* to the same store only as long as neither ever calls a mutating method
 * on it directly — every caller that means to change one owner's content without the other
 * seeing it must `clone()` first, exactly as `region-patch.ts`'s functions do.
 *
 * `channels` generalises RGBA8 (4 bytes/pixel, every `RasterLayer.pixels` caller) to any fixed
 * per-pixel byte count — `RasterLayerMask.pixels` is grayscale, one byte per pixel, and needs
 * the identical tiling/CoW machinery with a different stride, not a second, parallel
 * implementation of it (CLAUDE.md §4's "дубликат — это два будущих, которые разойдутся").
 * Defaults to 4 so every existing RGBA caller is unaffected.
 */
export class TileStore {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly #tiles: Map<number, Uint8ClampedArray>;

  private constructor(width: number, height: number, channels: number, tiles: Map<number, Uint8ClampedArray>) {
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.#tiles = tiles;
  }

  /** Builds a store from a flat, document/layer-shaped buffer — one crop per tile. */
  static fromPixels(pixels: Uint8ClampedArray, width: number, height: number, channels = 4): TileStore {
    if (pixels.length !== width * height * channels) throw new RangeError("TileStore.fromPixels: buffer length does not match width*height*channels");
    const tiles = new Map<number, Uint8ClampedArray>();
    const columns = Math.ceil(width / TILE_SIZE), rows = Math.ceil(height / TILE_SIZE);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const rect = tileRect(col, row, width, height);
        const tile = new Uint8ClampedArray(rect.width * rect.height * channels);
        for (let y = 0; y < rect.height; y += 1) {
          const from = ((rect.y + y) * width + rect.x) * channels;
          tile.set(pixels.subarray(from, from + rect.width * channels), y * rect.width * channels);
        }
        tiles.set(key(col, row), tile);
      }
    }
    return new TileStore(width, height, channels, tiles);
  }

  /** An all-zero (transparent, for RGBA; black, for a mask) store of the given size — every tile
   *  allocated (not sparse), so a freshly created layer costs one real materialize either way;
   *  sparse-on-read is a later optimisation this constructor deliberately leaves for when a real
   *  caller needs it. */
  static empty(width: number, height: number, channels = 4): TileStore {
    return TileStore.fromPixels(new Uint8ClampedArray(width * height * channels), width, height, channels);
  }

  /** O(tile count): copies the *map*, not the tiles it points to. The two stores diverge only
   *  where either one is actually written to afterward. */
  clone(): TileStore {
    return new TileStore(this.width, this.height, this.channels, new Map(this.#tiles));
  }

  /** Rebuilds one flat buffer — the escape hatch every existing consumer that still thinks in
   *  `Uint8ClampedArray` needs, the same role `layerDocumentPixels` already plays for
   *  bounds-cropped layers. */
  toPixels(): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(this.width * this.height * this.channels);
    const columns = Math.ceil(this.width / TILE_SIZE), rows = Math.ceil(this.height / TILE_SIZE);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const tile = this.#tiles.get(key(col, row));
        if (!tile) continue;
        const rect = tileRect(col, row, this.width, this.height);
        for (let y = 0; y < rect.height; y += 1) {
          const from = y * rect.width * this.channels;
          pixels.set(tile.subarray(from, from + rect.width * this.channels), ((rect.y + y) * this.width + rect.x) * this.channels);
        }
      }
    }
    return pixels;
  }

  /**
   * A plain, JSON-safe snapshot — `width`/`height`/`channels` plus one flat `pixels` buffer
   * (`toPixels()`). Exists because a bare `TileStore` instance is not one: its actual data lives
   * in a private `#tiles` field, which `JSON.stringify` cannot see at all — a naive
   * `JSON.stringify(store)` silently produces `{"width":W,"height":H,"channels":C}` with every
   * tile gone and no error anywhere. `document-snapshot-store.ts`'s autosave serializes a whole
   * `RasterDocumentState` this way (with a replacer that already knows how to serialize the
   * typed array this method's `pixels` field is), so anything reachable from a layer or mask
   * that is a `TileStore` needs this method to survive a save/reload — see `fromJSON`, the other
   * half of the round trip, and `document.ts`'s `migrateRasterDocumentState`, the one place that
   * calls it.
   */
  toJSON(): { width: number; height: number; channels: number; pixels: Uint8ClampedArray } {
    return { width: this.width, height: this.height, channels: this.channels, pixels: this.toPixels() };
  }

  /** The other half of `toJSON()`'s round trip — rebuilds a real `TileStore` (tiled, with a
   *  working `#tiles` map) from the plain shape `toJSON()`/`JSON.parse` leave behind. */
  static fromJSON(value: { width: number; height: number; channels: number; pixels: Uint8ClampedArray }): TileStore {
    return TileStore.fromPixels(value.pixels, value.width, value.height, value.channels);
  }

  /** One pixel's channel values, without materialising anything — `layerAlphaAt`'s reason to
   *  exist, generalised to a tiled store. Out-of-bounds reads as all-zero (transparent black for
   *  RGBA, 0 for a mask), the same convention `layerAlphaAt` uses. Always `this.channels` long —
   *  an RGBA store's callers destructure `[r, g, b, a]` exactly as before `channels` existed. */
  readPixel(x: number, y: number): readonly number[] {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return new Array(this.channels).fill(0);
    const col = Math.floor(x / TILE_SIZE), row = Math.floor(y / TILE_SIZE);
    const tile = this.#tiles.get(key(col, row));
    if (!tile) return new Array(this.channels).fill(0);
    const rect = tileRect(col, row, this.width, this.height);
    const index = ((y - rect.y) * rect.width + (x - rect.x)) * this.channels;
    const out = new Array<number>(this.channels);
    for (let c = 0; c < this.channels; c += 1) out[c] = tile[index + c]!;
    return out;
  }

  /**
   * `rect`'s own content as a `rect.width`×`rect.height` buffer addressed from (0,0) — the read
   * half of `writeLocalRegion`'s pair, and the shape `region-patch.ts`'s undo/redo swap needs for
   * what it hands back as the redo patch (`cropRegion`/`cropRegionAsMask`'s own output shape).
   * Bounded to `rect`, not this store's own extent — a small rectangle out of a huge mask costs
   * the small rectangle. Pixels `rect` reaches outside this store read back all-zero, matching
   * `readPixel`'s convention for a plain out-of-bounds read.
   */
  readLocalRegion(rect: RasterRect): Uint8ClampedArray {
    const channels = this.channels;
    const out = new Uint8ClampedArray(rect.width * rect.height * channels);
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) {
        const sample = this.readPixel(rect.x + x, rect.y + y);
        const index = (y * rect.width + x) * channels;
        for (let c = 0; c < channels; c += 1) out[index + c] = sample[c]!;
      }
    }
    return out;
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
    const channels = this.channels;
    const firstCol = Math.floor(left / TILE_SIZE), lastCol = Math.floor((right - 1) / TILE_SIZE);
    const firstRow = Math.floor(top / TILE_SIZE), lastRow = Math.floor((bottom - 1) / TILE_SIZE);
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let col = firstCol; col <= lastCol; col += 1) {
        const tileArea = tileRect(col, row, this.width, this.height);
        const existing = this.#tiles.get(key(col, row));
        const next = existing ? existing.slice() : new Uint8ClampedArray(tileArea.width * tileArea.height * channels);
        const writeLeft = Math.max(left, tileArea.x), writeTop = Math.max(top, tileArea.y);
        const writeRight = Math.min(right, tileArea.x + tileArea.width), writeBottom = Math.min(bottom, tileArea.y + tileArea.height);
        for (let y = writeTop; y < writeBottom; y += 1) {
          const fromSource = (y * sourceWidth + writeLeft) * channels;
          const toTile = ((y - tileArea.y) * tileArea.width + (writeLeft - tileArea.x)) * channels;
          next.set(source.subarray(fromSource, fromSource + (writeRight - writeLeft) * channels), toTile);
        }
        this.#tiles.set(key(col, row), next);
      }
    }
  }

  /**
   * The other shape a region write comes in: `patch` is exactly `rect.width`×`rect.height`,
   * addressed from its own (0,0) — not store-shaped like `writeRegion`'s `source`. This is what
   * `region-patch.ts`'s GIMP-style undo/redo swap actually holds (`cropRegionAsMask`'s own
   * output, and `swapLayerRegion`'s `patch` parameter): the whole reason that mechanism costs one
   * rectangle instead of a full canvas is that it never materialises a store-shaped buffer just
   * to hold a small edit. Requiring `writeRegion`'s wider contract here would force exactly that
   * allocation on every undo/redo, defeating the point for the sake of reusing one method.
   */
  writeLocalRegion(rect: RasterRect, patch: Uint8ClampedArray): void {
    const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
    const right = Math.min(this.width, rect.x + rect.width), bottom = Math.min(this.height, rect.y + rect.height);
    if (right <= left || bottom <= top) return;
    const channels = this.channels;
    const firstCol = Math.floor(left / TILE_SIZE), lastCol = Math.floor((right - 1) / TILE_SIZE);
    const firstRow = Math.floor(top / TILE_SIZE), lastRow = Math.floor((bottom - 1) / TILE_SIZE);
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let col = firstCol; col <= lastCol; col += 1) {
        const tileArea = tileRect(col, row, this.width, this.height);
        const existing = this.#tiles.get(key(col, row));
        const next = existing ? existing.slice() : new Uint8ClampedArray(tileArea.width * tileArea.height * channels);
        const writeLeft = Math.max(left, tileArea.x), writeTop = Math.max(top, tileArea.y);
        const writeRight = Math.min(right, tileArea.x + tileArea.width), writeBottom = Math.min(bottom, tileArea.y + tileArea.height);
        for (let y = writeTop; y < writeBottom; y += 1) {
          const fromPatch = ((y - rect.y) * rect.width + (writeLeft - rect.x)) * channels;
          const toTile = ((y - tileArea.y) * tileArea.width + (writeLeft - tileArea.x)) * channels;
          next.set(patch.subarray(fromPatch, fromPatch + (writeRight - writeLeft) * channels), toTile);
        }
        this.#tiles.set(key(col, row), next);
      }
    }
  }

  /**
   * A new store framed to `width`×`height`, whose own (0,0) is this store's (`dx`, `dy`) —
   * windows, crops, or pads this store into a different rectangle. This is `growToInclude`'s and
   * `trimInPlace`'s actual job: a layer's buffer is exactly its own opaque bounds (CLAUDE.md §4),
   * so every bounds change — every stroke that extends past what a layer used to hold, every trim
   * back afterward — needs exactly this. Pixels the new frame reaches that this store never
   * covered read back transparent, the same convention `readPixel` already uses for a plain
   * out-of-bounds read.
   *
   * A full (`TILE_SIZE`×`TILE_SIZE`) destination tile whose corresponding source tile is also
   * full-size — only possible when `dx`/`dy` are exact multiples of `TILE_SIZE` — is shared by
   * reference, the same trade `clone()` makes. Every other tile (the frame's own edges, and every
   * tile at all when the shift is not tile-aligned) is rebuilt from whatever this store holds at
   * the corresponding source pixels — real work, but bounded to that one destination tile, not to
   * this store's own extent: reframing a small rectangle out of a huge layer costs the small
   * rectangle, not the huge layer, which is the whole reason `growToInclude` on a layer that
   * already covers most of a large canvas is worth fixing.
   */
  reframe(dx: number, dy: number, width: number, height: number): TileStore {
    const channels = this.channels;
    const tiles = new Map<number, Uint8ClampedArray>();
    const columns = Math.ceil(width / TILE_SIZE), rows = Math.ceil(height / TILE_SIZE);
    const tileAligned = dx % TILE_SIZE === 0 && dy % TILE_SIZE === 0;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const destRect = tileRect(col, row, width, height);
        if (tileAligned && destRect.width === TILE_SIZE && destRect.height === TILE_SIZE) {
          const sourceCol = col + dx / TILE_SIZE, sourceRow = row + dy / TILE_SIZE;
          const sourceFullSize = sourceCol >= 0 && sourceRow >= 0
            && tileRect(sourceCol, sourceRow, this.width, this.height).width === TILE_SIZE
            && tileRect(sourceCol, sourceRow, this.width, this.height).height === TILE_SIZE;
          if (sourceFullSize) {
            tiles.set(key(col, row), this.#tiles.get(key(sourceCol, sourceRow)) ?? new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * channels));
            continue;
          }
        }
        // General path: this destination tile has no single same-size source tile to borrow, so
        // it is rebuilt pixel by pixel from wherever this store holds content at (x+dx, y+dy) —
        // `readPixel` already knows out-of-range means transparent, which is exactly what a
        // frame reaching past this store's own edge should read as.
        const tile = new Uint8ClampedArray(destRect.width * destRect.height * channels);
        for (let y = 0; y < destRect.height; y += 1) {
          for (let x = 0; x < destRect.width; x += 1) {
            const sample = this.readPixel(destRect.x + x + dx, destRect.y + y + dy);
            const index = (y * destRect.width + x) * channels;
            for (let c = 0; c < channels; c += 1) tile[index + c] = sample[c]!;
          }
        }
        tiles.set(key(col, row), tile);
      }
    }
    return new TileStore(width, height, channels, tiles);
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

  /** Every tile array this store currently holds, for a caller doing its own generic
   *  buffer-identity accounting (`layer-bounds.ts`'s `visitPixelBuffers`) rather than the
   *  tile-store-specific `uniqueBytes` above — the two clones sharing a tile still visit the
   *  identical object, so a `Set`-based dedupe on the caller's side works the same as always. */
  *tileBuffers(): IterableIterator<Uint8ClampedArray> {
    yield* this.#tiles.values();
  }
}
