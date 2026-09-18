import { allocatePixels, bufferDepth, convertPixelDepth, toRgba8, type PixelBuffer, type RasterBitDepth } from "./pixel-format";
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

/** One chunk on its way into a snapshot: named, placed, and not yet materialised. */
export interface TileChunkHandle {
  readonly __vravioChunk: true;
  readonly contentKey: string;
  readonly rect: RasterRect;
  readonly arrayType: string;
  readonly bytes: () => PixelBuffer;
}

interface TileStoreShape { width: number; height: number; channels: number; depth: RasterBitDepth; contentKey: string }
export type TileStoreSnapshot = (TileStoreShape & { chunks: readonly TileChunkHandle[] }) | (TileStoreShape & { evicted: true });
/** What comes back from a snapshot after the writer has replaced the handles with real buffers —
 *  plus the two older shapes still on disk in existing sessions. */
export type RestoredTileStoreSnapshot =
  | { width: number; height: number; channels: number; depth?: RasterBitDepth; contentKey?: string; chunks: readonly { contentKey?: string; rect: RasterRect; pixels?: PixelBuffer; bytes?: () => PixelBuffer }[] }
  | { width: number; height: number; channels: number; depth?: RasterBitDepth; contentKey?: string; pixels: PixelBuffer }
  | { width: number; height: number; channels: number; depth?: RasterBitDepth; contentKey?: string; evicted: true };

const key = (col: number, row: number) => col * 0x10000 + row;

/**
 * Names for "this exact content", handed out fresh on every change.
 *
 * `document-snapshot-store.ts` skips rewriting a buffer it already has on disk, and it used to
 * decide that by the buffer's own identity — correct while a layer held one `Uint8ClampedArray`
 * that was replaced wholesale on every edit. Tiled storage broke that silently: `toJSON()`
 * materialises a *new* flat buffer on every call, so nothing ever looked unchanged and every
 * autosave rewrote every layer of every open document. Measured on a 3000x3000, six-layer
 * document: 61.8 MB written per save with nothing edited at all (docs/master-plan.md §60).
 *
 * A counter rather than a hash: hashing megabytes to find out whether to write megabytes costs
 * the same order as the write. A fresh name on every mutation is exact in the direction that
 * matters — two stores with the same key always have the same content, because the only way to
 * get the same key is to be a clone that nobody has written to since.
 */
let nextContentKey = 1;
/**
 * A name only this run of the program hands out.
 *
 * Without it the counter alone was a correctness bug, not just a weak name: a restored store
 * *adopts* the name its snapshot carried (`t57`), the counter starts again at 1 in the new run,
 * and sooner or later it issues `t57` to a completely different chunk — which the autosave then
 * recognises as "already on disk" and does not write. Found by reloading a session and reading the
 * pixels back: one edited chunk had survived and another had silently reverted (master-plan §63).
 */
const RUN_ID = Math.random().toString(36).slice(2, 10);
const freshContentKey = (): string => `${RUN_ID}-${nextContentKey++}`;

/**
 * How many tiles across a persistence chunk is — 16x16 tiles, or 1024x1024 pixels, 4 MB of RGBA.
 *
 * Chosen against three measured costs, not two (docs/master-plan.md §63):
 *   - writing a 34 MB layer as one blob is ~160 ms, a 4 MB chunk ~30 ms, a 1 MB chunk ~9 ms;
 *   - each separate write carries ~4 ms of its own overhead, so very small chunks make a
 *     whole-layer change *slower* than it was;
 *   - and the one that decided it: **the number of files matters more than their size**. OPFS
 *     enumerates a directory an entry at a time, and at 512x512 chunks a six-layer 3000x3000
 *     document became ~500 files, whose directory walk measured 10.7 s. 1024x1024 makes that
 *     document ~60 files.
 */
export const SNAPSHOT_CHUNK_TILES = 16;
const CHUNK_SIZE = TILE_SIZE * SNAPSHOT_CHUNK_TILES;

/**
 * Thrown by any `TileStore` method that needs real pixel bytes when called on a store built by
 * `TileStore.placeholder()` — docs/master-plan.md §37.3 item 6's swap-out marker. A quiet
 * transparent-pixel fallback here (the same convention out-of-bounds reads already use) would be
 * the worse choice for this specific case: an out-of-bounds read is a normal, expected shape a
 * caller already handles, but a read reaching a placeholder means a layer that item 6's swap
 * manager (`apps/web/src/raster-layer-swap.ts`) decided was safe to evict — hidden, not the active
 * layer — is being touched by some call site that was not accounted for when that eligibility rule
 * was written. Failing loudly here turns a missed audit point into an immediate, obvious crash
 * during testing, instead of a silently blank thumbnail, a silently empty layer in an export, or a
 * silently corrupted undo step — the exact "quiet wrong" class of bug CLAUDE.md §4 warns about,
 * just discovered by a stack trace instead of by a user noticing something is missing days later.
 */
export class EvictedTileStoreError extends Error {
  constructor(operation: string) {
    super(`TileStore.${operation}: this store is evicted (docs/master-plan.md §37.3 item 6) — it must be restored via the layer swap manager before this operation, not read directly`);
    this.name = "EvictedTileStoreError";
  }
}

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
  /**
   * Bits per channel of the tiles this store actually holds (docs/master-plan.md §59.2).
   *
   * The 8-bit methods below (`toPixels`, `readLocalRegion`, `readPixel`) keep their contract at
   * every depth by converting — babl's bargain, and the reason a 16-bit layer works with the
   * hundreds of call sites written before depth existed. The `…Deep` pair speaks the store's own
   * format, for the operations that were taught precision.
   */
  readonly depth: RasterBitDepth;
  /**
   * What this store's current content is called, for anything that needs to know whether it has
   * changed since it last looked (autosave, today). Changes on every write; survives `clone()`,
   * because a clone nobody has written to holds the same bytes.
   */
  #contentKey: string = freshContentKey();
  /** The same idea per persistence chunk, so a save rewrites only the chunks a stroke touched. */
  #chunkKeys = new Map<number, string>();
  readonly #tiles: Map<number, PixelBuffer>;
  readonly #evicted: boolean;

  private constructor(width: number, height: number, channels: number, tiles: Map<number, PixelBuffer>, evicted = false, depth: RasterBitDepth = 8) {
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.depth = depth;
    this.#tiles = tiles;
    this.#evicted = evicted;
  }

  /** Whether this store was built by `placeholder()` and holds no real tile bytes right now. */
  get evicted(): boolean { return this.#evicted; }

  /** @see `#contentKey`. */
  get contentKey(): string { return this.#contentKey; }

  /** Adopts a content name a snapshot already knows this content by — the restore side of the
   *  save above, so the first autosave after a session reload does not rewrite what it just read. */
  adoptContentKey(value: string): void { this.#contentKey = value; }

  /**
   * A store shaped like a real `width`×`height`×`channels` `TileStore` but holding zero tiles —
   * O(1) memory, not O(width×height) the way `empty()` deliberately is. This is the actual point:
   * `empty()` exists for "a freshly created layer that will be painted on", where allocating real
   * (zeroed) tiles is correct and unavoidable; `placeholder()` exists for "this layer's real tiles
   * were just persisted elsewhere and this JS heap allocation is being freed", where allocating
   * anything at all would defeat the whole purpose. Every method that would need to read or write
   * real bytes throws `EvictedTileStoreError` instead of fabricating content — see that class's own
   * doc comment for why silence is the wrong choice here specifically.
   */
  static placeholder(width: number, height: number, channels = 4, depth: RasterBitDepth = 8): TileStore {
    return new TileStore(width, height, channels, new Map(), true, depth);
  }

  /** Builds a store from a flat, document/layer-shaped buffer — one crop per tile. */
  static fromPixels(pixels: PixelBuffer, width: number, height: number, channels = 4, depth: RasterBitDepth = bufferDepth(pixels)): TileStore {
    if (pixels.length !== width * height * channels) throw new RangeError("TileStore.fromPixels: buffer length does not match width*height*channels");
    // A buffer handed in at one depth for a store of another is converted once, here, rather than
    // being trusted: the alternative is tiles whose type disagrees with `depth`, which nothing
    // downstream would notice until the numbers came out wrong.
    const source = bufferDepth(pixels) === depth ? pixels : convertPixelDepth(pixels, bufferDepth(pixels), depth);
    const tiles = new Map<number, PixelBuffer>();
    const columns = Math.ceil(width / TILE_SIZE), rows = Math.ceil(height / TILE_SIZE);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const rect = tileRect(col, row, width, height);
        const tile = allocatePixels(depth, rect.width * rect.height * channels);
        for (let y = 0; y < rect.height; y += 1) {
          const from = ((rect.y + y) * width + rect.x) * channels;
          tile.set(source.subarray(from, from + rect.width * channels) as never, y * rect.width * channels);
        }
        tiles.set(key(col, row), tile);
      }
    }
    return new TileStore(width, height, channels, tiles, false, depth);
  }

  /** An all-zero (transparent, for RGBA; black, for a mask) store of the given size — every tile
   *  allocated (not sparse), so a freshly created layer costs one real materialize either way;
   *  sparse-on-read is a later optimisation this constructor deliberately leaves for when a real
   *  caller needs it. */
  static empty(width: number, height: number, channels = 4, depth: RasterBitDepth = 8): TileStore {
    return TileStore.fromPixels(allocatePixels(depth, width * height * channels), width, height, channels, depth);
  }

  /** O(tile count): copies the *map*, not the tiles it points to. The two stores diverge only
   *  where either one is actually written to afterward. An evicted store clones to another
   *  evicted store — cheap and harmless, since the next real read or write still throws. */
  clone(): TileStore {
    const copy = new TileStore(this.width, this.height, this.channels, new Map(this.#tiles), this.#evicted, this.depth);
    copy.#contentKey = this.#contentKey;
    copy.#chunkKeys = new Map(this.#chunkKeys);
    return copy;
  }

  /** Renames the chunks a rectangle of *store* coordinates overlaps — every write goes through here
   *  so that "which chunks changed" is bookkeeping, never a comparison of megabytes. */
  #renameChunks(rect: RasterRect): void {
    const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
    const right = Math.min(this.width, rect.x + rect.width), bottom = Math.min(this.height, rect.y + rect.height);
    if (right <= left || bottom <= top) return;
    for (let row = Math.floor(top / CHUNK_SIZE); row <= Math.floor((bottom - 1) / CHUNK_SIZE); row += 1) {
      for (let col = Math.floor(left / CHUNK_SIZE); col <= Math.floor((right - 1) / CHUNK_SIZE); col += 1) {
        this.#chunkKeys.set(key(col, row), freshContentKey());
      }
    }
  }

  /**
   * This store as the pieces a snapshot writes: one entry per chunk, each with a name for its
   * content and a thunk for its bytes.
   *
   * The thunk is the point. A caller that already has this chunk's name on disk never calls it, so
   * an unchanged chunk costs nothing at all — no copy, no allocation. Before this, saving a
   * document materialised every layer in full just to discover there was nothing to write
   * (docs/master-plan.md §63).
   */
  snapshotChunks(): readonly { readonly contentKey: string; readonly rect: RasterRect; readonly bytes: () => PixelBuffer }[] {
    if (this.#evicted) throw new EvictedTileStoreError("snapshotChunks");
    const chunks: { contentKey: string; rect: RasterRect; bytes: () => PixelBuffer }[] = [];
    const columns = Math.ceil(this.width / CHUNK_SIZE), rows = Math.ceil(this.height / CHUNK_SIZE);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const x = col * CHUNK_SIZE, y = row * CHUNK_SIZE;
        const rect: RasterRect = { x, y, width: Math.min(CHUNK_SIZE, this.width - x), height: Math.min(CHUNK_SIZE, this.height - y) };
        const id = key(col, row);
        let name = this.#chunkKeys.get(id);
        if (!name) { name = freshContentKey(); this.#chunkKeys.set(id, name); }
        chunks.push({ contentKey: name, rect, bytes: () => this.readLocalRegionDeep(rect) });
      }
    }
    return chunks;
  }

  /** Rebuilds a store from `snapshotChunks()`'s pieces — the other half of that round trip. */
  static fromChunks(
    width: number, height: number, channels: number, depth: RasterBitDepth,
    chunks: readonly { readonly contentKey?: string; readonly rect: RasterRect; readonly pixels?: PixelBuffer; readonly bytes?: () => PixelBuffer }[],
    contentKey?: string,
  ): TileStore {
    const store = TileStore.empty(width, height, channels, depth);
    for (const chunk of chunks) {
      // Either the bytes a writer already put back, or a handle that has not been asked yet — a
      // snapshot rebuilt in memory (a test, a copy that never went to storage) still holds thunks,
      // and refusing that would be a trap with no upside.
      const pixels = chunk.pixels ?? chunk.bytes?.();
      if (!pixels) continue;
      store.writeLocalRegion(chunk.rect, pixels);
      if (chunk.contentKey) store.#chunkKeys.set(key(Math.floor(chunk.rect.x / CHUNK_SIZE), Math.floor(chunk.rect.y / CHUNK_SIZE)), chunk.contentKey);
    }
    if (contentKey) store.#contentKey = contentKey;
    return store;
  }

  /** The same content held at another depth — what Image ▸ Mode ▸ 16 Bits/Channel does to every
   *  layer. A conversion down clips and rounds (there is nowhere else for the values to go); a
   *  conversion up is exact, so 8 → 16 → 8 returns the original bytes. */
  withDepth(depth: RasterBitDepth): TileStore {
    if (depth === this.depth) return this.clone();
    if (this.#evicted) return TileStore.placeholder(this.width, this.height, this.channels, depth);
    const tiles = new Map<number, PixelBuffer>();
    for (const [id, tile] of this.#tiles) tiles.set(id, convertPixelDepth(tile, this.depth, depth));
    return new TileStore(this.width, this.height, this.channels, tiles, false, depth);
  }

  /** Rebuilds one flat buffer — the escape hatch every existing consumer that still thinks in
   *  `Uint8ClampedArray` needs, the same role `layerDocumentPixels` already plays for
   *  bounds-cropped layers. */
  toPixels(): Uint8ClampedArray {
    return toRgba8(this.toPixelsDeep());
  }

  /** `toPixels()` in this store's own format — the 32-bit highlights and 16-bit steps that the
   *  8-bit view above necessarily loses. Identical to `toPixels()` for an 8-bit store. */
  toPixelsDeep(): PixelBuffer {
    if (this.#evicted) throw new EvictedTileStoreError("toPixels");
    const pixels = allocatePixels(this.depth, this.width * this.height * this.channels);
    const columns = Math.ceil(this.width / TILE_SIZE), rows = Math.ceil(this.height / TILE_SIZE);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const tile = this.#tiles.get(key(col, row));
        if (!tile) continue;
        const rect = tileRect(col, row, this.width, this.height);
        for (let y = 0; y < rect.height; y += 1) {
          const from = y * rect.width * this.channels;
          pixels.set(tile.subarray(from, from + rect.width * this.channels) as never, ((rect.y + y) * this.width + rect.x) * this.channels);
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
   *
   * An evicted store (docs/master-plan.md §37.3 item 6) is the one case this does *not* throw
   * `EvictedTileStoreError` for, unlike every other method that needs real bytes: found live,
   * autosave calls this on every layer of every open document on its own idle timer, evicted or
   * not, with no way to ask first — and unlike `toPixels()`, this is not being asked to fabricate
   * pixels to use, only to describe this store's current state as data, and "currently evicted" is
   * a real, representable state. The `{ evicted: true }` shape carries no `pixels` field at all, so
   * `document-snapshot-store.ts`'s replacer (which only intercepts typed-array values) leaves it as
   * plain JSON — a session reload brings a layer back exactly as evicted as it was, its real bytes
   * still wherever the layer swap manager's own storage already has them, not duplicated into the
   * autosave snapshot a second time.
   */
  toJSON(): TileStoreSnapshot {
    if (this.#evicted) return { width: this.width, height: this.height, channels: this.channels, depth: this.depth, contentKey: this.#contentKey, evicted: true };
    // Chunks, not one flat buffer, and each one lazy: a writer that already has a chunk's content
    // never asks for its bytes, so an unchanged layer costs nothing to save (master-plan §63). The
    // depth travels with it — a save that wrote the 8-bit view would quietly turn every 16-bit
    // document into an 8-bit one the first time the session was restored.
    return {
      width: this.width, height: this.height, channels: this.channels, depth: this.depth, contentKey: this.#contentKey,
      chunks: this.snapshotChunks().map((chunk) => ({ __vravioChunk: true as const, contentKey: chunk.contentKey, rect: chunk.rect, arrayType: allocatePixels(this.depth, 0).constructor.name, bytes: chunk.bytes })),
    };
  }

  /** The other half of `toJSON()`'s round trip — rebuilds a real `TileStore` (tiled, with a
   *  working `#tiles` map) from the plain shape `toJSON()`/`JSON.parse` leave behind, or another
   *  placeholder from the `{ evicted: true }` shape a store evicted at save time leaves instead. */
  static fromJSON(value: RestoredTileStoreSnapshot): TileStore {
    // Three shapes, because three eras of this file are still readable: chunks (now), one flat
    // `pixels` buffer (§59.2), and a store that was evicted when the snapshot was taken.
    // `depth` is optional on the way in — every save written before §59.2 is 8-bit, and the buffer
    // that comes back from `JSON.parse` says so itself anyway.
    if ("chunks" in value && Array.isArray(value.chunks)) {
      const first = value.chunks[0]?.pixels ?? value.chunks[0]?.bytes?.();
      const depth = value.depth ?? (first ? bufferDepth(first) : 8);
      return TileStore.fromChunks(value.width, value.height, value.channels, depth, value.chunks, value.contentKey);
    }
    const depth = value.depth ?? ("pixels" in value ? bufferDepth(value.pixels) : 8);
    const store = "pixels" in value
      ? TileStore.fromPixels(value.pixels, value.width, value.height, value.channels, depth)
      : TileStore.placeholder(value.width, value.height, value.channels, depth);
    if (value.contentKey) store.adoptContentKey(value.contentKey);
    return store;
  }

  /** One pixel's channel values, without materialising anything — `layerAlphaAt`'s reason to
   *  exist, generalised to a tiled store. Out-of-bounds reads as all-zero (transparent black for
   *  RGBA, 0 for a mask), the same convention `layerAlphaAt` uses. Always `this.channels` long —
   *  an RGBA store's callers destructure `[r, g, b, a]` exactly as before `channels` existed. */
  readPixel(x: number, y: number): readonly number[] {
    if (this.#evicted) throw new EvictedTileStoreError("readPixel");
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
    return toRgba8(this.readLocalRegionDeep(rect));
  }

  /**
   * `readLocalRegion` in this store's own format, for an operation that was taught precision.
   *
   * Copied as spans, not pixel by pixel. The obvious loop calls `readPixel` per pixel, and
   * `readPixel` allocates a small array for its return value — a million-pixel region meant a
   * million short-lived arrays and a million tile lookups for data that lies contiguously in
   * memory. It only started to matter when the deep adjustment and filter paths (§59.2a, §59.2b)
   * began reading whole layers through here; `set(subarray)` on the run of pixels a tile row
   * contributes is the same copy the browser does with `memcpy`.
   *
   * Pixels the rectangle reaches outside this store stay zero, which is what `allocatePixels`
   * already gives and what `readPixel`'s own out-of-bounds convention says they should be.
   */
  readLocalRegionDeep(rect: RasterRect): PixelBuffer {
    if (this.#evicted) throw new EvictedTileStoreError("readLocalRegion");
    const channels = this.channels;
    const out = allocatePixels(this.depth, rect.width * rect.height * channels);
    const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
    const right = Math.min(this.width, rect.x + rect.width), bottom = Math.min(this.height, rect.y + rect.height);
    if (right <= left || bottom <= top) return out;
    for (let y = top; y < bottom; y += 1) {
      const row = y - rect.y;
      let x = left;
      while (x < right) {
        const col = Math.floor(x / TILE_SIZE);
        const tileArea = tileRect(col, Math.floor(y / TILE_SIZE), this.width, this.height);
        const runEnd = Math.min(right, tileArea.x + tileArea.width);
        const tile = this.#tiles.get(key(col, Math.floor(y / TILE_SIZE)));
        if (tile) {
          const from = ((y - tileArea.y) * tileArea.width + (x - tileArea.x)) * channels;
          out.set(tile.subarray(from, from + (runEnd - x) * channels) as never, (row * rect.width + (x - rect.x)) * channels);
        }
        x = runEnd;
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
  writeRegion(rect: RasterRect, source: PixelBuffer, sourceWidth: number): void {
    if (this.#evicted) throw new EvictedTileStoreError("writeRegion");
    this.#contentKey = freshContentKey();
    this.#renameChunks(rect);
    // A write at another depth is converted before it lands, so an 8-bit tool can keep writing
    // into a 16-bit layer exactly as it did - the same boundary `toPixels()` holds on the way out.
    if (bufferDepth(source) !== this.depth) source = convertPixelDepth(source, bufferDepth(source), this.depth);
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
        const next = existing ? existing.slice() : allocatePixels(this.depth, tileArea.width * tileArea.height * channels);
        const writeLeft = Math.max(left, tileArea.x), writeTop = Math.max(top, tileArea.y);
        const writeRight = Math.min(right, tileArea.x + tileArea.width), writeBottom = Math.min(bottom, tileArea.y + tileArea.height);
        for (let y = writeTop; y < writeBottom; y += 1) {
          const fromSource = (y * sourceWidth + writeLeft) * channels;
          const toTile = ((y - tileArea.y) * tileArea.width + (writeLeft - tileArea.x)) * channels;
          next.set(source.subarray(fromSource, fromSource + (writeRight - writeLeft) * channels) as never, toTile);
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
  writeLocalRegion(rect: RasterRect, patch: PixelBuffer): void {
    if (this.#evicted) throw new EvictedTileStoreError("writeLocalRegion");
    this.#contentKey = freshContentKey();
    this.#renameChunks(rect);
    if (bufferDepth(patch) !== this.depth) patch = convertPixelDepth(patch, bufferDepth(patch), this.depth);
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
        const next = existing ? existing.slice() : allocatePixels(this.depth, tileArea.width * tileArea.height * channels);
        const writeLeft = Math.max(left, tileArea.x), writeTop = Math.max(top, tileArea.y);
        const writeRight = Math.min(right, tileArea.x + tileArea.width), writeBottom = Math.min(bottom, tileArea.y + tileArea.height);
        for (let y = writeTop; y < writeBottom; y += 1) {
          const fromPatch = ((y - rect.y) * rect.width + (writeLeft - rect.x)) * channels;
          const toTile = ((y - tileArea.y) * tileArea.width + (writeLeft - tileArea.x)) * channels;
          next.set(patch.subarray(fromPatch, fromPatch + (writeRight - writeLeft) * channels) as never, toTile);
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
    if (this.#evicted) throw new EvictedTileStoreError("reframe");
    const channels = this.channels;
    const tiles = new Map<number, PixelBuffer>();
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
            tiles.set(key(col, row), this.#tiles.get(key(sourceCol, sourceRow)) ?? allocatePixels(this.depth, TILE_SIZE * TILE_SIZE * channels));
            continue;
          }
        }
        // General path: this destination tile has no single same-size source tile to borrow, so
        // it is rebuilt pixel by pixel from wherever this store holds content at (x+dx, y+dy) —
        // `readPixel` already knows out-of-range means transparent, which is exactly what a
        // frame reaching past this store's own edge should read as.
        const tile = allocatePixels(this.depth, destRect.width * destRect.height * channels);
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
    return new TileStore(width, height, channels, tiles, false, this.depth);
  }

  /** Bytes held by tiles unique to this store — `seen` lets a caller price several clones
   *  together the same way `accumulateUniquePixelBytes` prices layers sharing whole buffers. */
  uniqueBytes(seen: Set<PixelBuffer>): number {
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
  *tileBuffers(): IterableIterator<PixelBuffer> {
    yield* this.#tiles.values();
  }
}
