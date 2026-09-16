import { describe, expect, it } from "vitest";
import { TileStore, TILE_SIZE } from "./tile-store";

/** A deterministic, non-uniform buffer so a copy/crop bug shows up as a wrong value, not an
 *  accidental match against a flat fill. */
function fixture(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 37 + 11) % 256;
  return pixels;
}

/** `writeRegion`'s `source` is store-shaped (same convention as `cropToRect`), not
 *  `rect`-shaped — a store-sized, all-zero buffer with `value` filled in at `rect` is what a
 *  real caller (already holding a full canvas-sized working buffer) would actually hand it. */
function storeSizedFill(width: number, height: number, rect: { x: number; y: number; width: number; height: number }, value: number): Uint8ClampedArray {
  const buffer = new Uint8ClampedArray(width * height * 4);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = (y * width + x) * 4;
      buffer[index] = value; buffer[index + 1] = value; buffer[index + 2] = value; buffer[index + 3] = value;
    }
  }
  return buffer;
}

describe("TileStore.fromPixels / toPixels", () => {
  it("round-trips a buffer that divides evenly into tiles", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE * 3;
    const source = fixture(w, h);
    expect([...TileStore.fromPixels(source, w, h).toPixels()]).toEqual([...source]);
  });

  it("round-trips a buffer whose edges cut a tile short", () => {
    const w = TILE_SIZE + 17, h = TILE_SIZE * 2 + 5;
    const source = fixture(w, h);
    expect([...TileStore.fromPixels(source, w, h).toPixels()]).toEqual([...source]);
  });

  it("round-trips a buffer smaller than one tile", () => {
    const w = 9, h = 5;
    const source = fixture(w, h);
    expect([...TileStore.fromPixels(source, w, h).toPixels()]).toEqual([...source]);
  });

  it("rejects a buffer whose length does not match width*height*4", () => {
    expect(() => TileStore.fromPixels(new Uint8ClampedArray(4), 2, 2)).toThrow(RangeError);
  });

  it("empty() is a real all-transparent buffer, not a sparse placeholder", () => {
    const store = TileStore.empty(10, 10);
    expect([...store.toPixels()]).toEqual([...new Uint8ClampedArray(10 * 10 * 4)]);
  });
});

describe("TileStore.toJSON / fromJSON — the document-snapshot-store.ts round trip", () => {
  it("a bare instance, JSON.stringified without toJSON, would lose every tile silently", () => {
    // Not testing TileStore's real toJSON here — testing the failure mode it exists to prevent.
    // `#tiles` is a private field: plain JSON.stringify never sees it, with no error of any kind,
    // which is exactly how this would fail in production (a saved document that quietly comes
    // back with an empty mask, not a thrown exception pointing at the cause).
    class Bare { readonly width = 10; readonly height = 10; readonly channels = 4; #tiles = new Map([[0, new Uint8ClampedArray(4)]]); }
    expect(JSON.parse(JSON.stringify(new Bare()))).toEqual({ width: 10, height: 10, channels: 4 });
  });

  it("toJSON()'s pixels field is a real typed array, the shape document-snapshot-store.ts's replacer already knows how to serialize", () => {
    // document-snapshot-store.ts's own replacer intercepts `ArrayBuffer.isView(value)` *before*
    // JSON.stringify's default (and lossy, for a typed array — see the sibling test below)
    // per-index serialization ever runs. toJSON() only has to hand back that shape; the actual
    // typed-array-safe encoding is the kernel's job, downstream of this method, not this file's.
    const store = TileStore.fromPixels(fixture(TILE_SIZE, TILE_SIZE), TILE_SIZE, TILE_SIZE);
    const snapshot = store.toJSON();
    expect(ArrayBuffer.isView(snapshot.pixels)).toBe(true);
    expect(snapshot.pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(snapshot).toEqual({ width: TILE_SIZE, height: TILE_SIZE, channels: 4, pixels: store.toPixels() });
  });

  it("plain JSON.stringify (no replacer) on a typed array is itself lossy in shape, not just on TileStore — confirming why a replacer is required downstream", () => {
    // A typed array is not `Array.isArray`, so JSON.stringify serializes it index-by-index as a
    // plain object (`{"0":v0,"1":v1,...}`), not as a `[...]` array. This is why
    // document-snapshot-store.ts's replacer exists and intercepts typed arrays explicitly — a
    // naive round trip through bare JSON.stringify/JSON.parse would not reconstruct an array-like
    // `pixels` at all, with or without toJSON() in the picture.
    const raw = JSON.parse(JSON.stringify(new Uint8ClampedArray([1, 2, 3])));
    expect(Array.isArray(raw)).toBe(false);
    expect(raw).toEqual({ 0: 1, 1: 2, 2: 3 });
  });

  it("fromJSON rebuilds a working, tiled store from toJSON()'s shape", () => {
    const w = TILE_SIZE + 9, h = TILE_SIZE * 2 + 3;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    const rebuilt = TileStore.fromJSON(store.toJSON());
    expect(rebuilt.width).toBe(w);
    expect(rebuilt.height).toBe(h);
    expect(rebuilt.channels).toBe(4);
    expect([...rebuilt.toPixels()]).toEqual([...source]);
    // A real tiled store, not a flat-buffer impostor: writeRegion still only touches the tiles
    // the region overlaps, same as any other TileStore.
    rebuilt.writeRegion({ x: 0, y: 0, width: 5, height: 5 }, new Uint8ClampedArray(w * h * 4).fill(200), w);
    expect(rebuilt.readPixel(2, 2)).toEqual([200, 200, 200, 200]);
  });

  it("round-trips a mask-shaped (channels: 1) store the same way", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE;
    const source = new Uint8ClampedArray(w * h);
    for (let i = 0; i < source.length; i += 1) source[i] = (i * 41 + 5) % 256;
    const store = TileStore.fromPixels(source, w, h, 1);
    const rebuilt = TileStore.fromJSON(store.toJSON());
    expect(rebuilt.channels).toBe(1);
    expect([...rebuilt.toPixels()]).toEqual([...source]);
  });

  it("the round trip is a real, independent copy, not a shared reference back to the original store", () => {
    const w = TILE_SIZE, h = TILE_SIZE;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    const rebuilt = TileStore.fromJSON(store.toJSON());
    store.writeRegion({ x: 0, y: 0, width: 5, height: 5 }, new Uint8ClampedArray(w * h * 4).fill(255), w);
    expect(rebuilt.readPixel(2, 2)).not.toEqual([255, 255, 255, 255]);
  });
});

describe("TileStore.readPixel", () => {
  it("matches the flat buffer at every corner of a multi-tile store", () => {
    const w = TILE_SIZE + 20, h = TILE_SIZE + 10;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [TILE_SIZE, TILE_SIZE], [TILE_SIZE - 1, TILE_SIZE - 1]]) {
      const index = (y! * w + x!) * 4;
      expect(store.readPixel(x!, y!)).toEqual([source[index], source[index + 1], source[index + 2], source[index + 3]]);
    }
  });

  it("reads out-of-bounds as transparent black", () => {
    const store = TileStore.empty(10, 10);
    expect(store.readPixel(-1, 0)).toEqual([0, 0, 0, 0]);
    expect(store.readPixel(0, -1)).toEqual([0, 0, 0, 0]);
    expect(store.readPixel(10, 0)).toEqual([0, 0, 0, 0]);
    expect(store.readPixel(0, 10)).toEqual([0, 0, 0, 0]);
  });
});

describe("TileStore.clone — the copy-on-write contract", () => {
  it("a clone starts out reading identically to its source", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE * 2;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    const clone = store.clone();
    expect([...clone.toPixels()]).toEqual([...store.toPixels()]);
  });

  it("writing to the clone never changes the source's tiles", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE * 2;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    const clone = store.clone();

    const rect = { x: 5, y: 5, width: 20, height: 20 };
    clone.writeRegion(rect, storeSizedFill(w, h, rect, 255), w);

    expect([...store.toPixels()]).toEqual([...source]);
    expect(clone.readPixel(10, 10)).toEqual([255, 255, 255, 255]);
  });

  it("writing to the source never changes an already-taken clone", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE * 2;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    const clone = store.clone();
    const before = clone.toPixels();

    const rect = { x: 70, y: 70, width: 20, height: 20 };
    store.writeRegion(rect, storeSizedFill(w, h, rect, 128), w);

    expect([...clone.toPixels()]).toEqual([...before]);
  });

  it("two independent clones of the same store diverge independently", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE * 2;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    const a = store.clone(), b = store.clone();

    a.writeRegion({ x: 0, y: 0, width: 10, height: 10 }, new Uint8ClampedArray(10 * 10 * 4).fill(200), 10);
    b.writeRegion({ x: 0, y: 0, width: 10, height: 10 }, new Uint8ClampedArray(10 * 10 * 4).fill(50), 10);

    expect(a.readPixel(5, 5)).toEqual([200, 200, 200, 200]);
    expect(b.readPixel(5, 5)).toEqual([50, 50, 50, 50]);
    expect(store.readPixel(5, 5)).toEqual((() => {
      const source = fixture(w, h);
      const index = (5 * w + 5) * 4;
      return [source[index], source[index + 1], source[index + 2], source[index + 3]];
    })());
  });
});

describe("TileStore.writeRegion", () => {
  it("matches a reference flat-buffer write, including a region straddling several tiles", () => {
    const w = TILE_SIZE * 2 + 10, h = TILE_SIZE * 2 + 10;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);

    const rect = { x: TILE_SIZE - 5, y: TILE_SIZE - 5, width: 40, height: 40 };
    // Store-shaped, with distinct, position-derived values inside `rect` — a plain fill would
    // not catch a row/column transposed by mistake inside the patched region.
    const patch = new Uint8ClampedArray(w * h * 4);
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const index = (y * w + x) * 4;
        const value = ((y - rect.y) * rect.width + (x - rect.x)) * 13 + 3;
        patch[index] = value; patch[index + 1] = value + 1; patch[index + 2] = value + 2; patch[index + 3] = value + 3;
      }
    }
    store.writeRegion(rect, patch, w);

    const reference = source.slice();
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      const from = (y * w + rect.x) * 4;
      reference.set(patch.subarray(from, from + rect.width * 4), from);
    }
    expect([...store.toPixels()]).toEqual([...reference]);
  });

  it("clips a write that overhangs the store's own edge instead of throwing or corrupting", () => {
    const w = 30, h = 30;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    const rect = { x: 20, y: 20, width: 20, height: 20 };
    store.writeRegion(rect, storeSizedFill(w, h, rect, 77), w);
    expect(store.readPixel(25, 25)).toEqual([77, 77, 77, 77]);
    expect(store.readPixel(29, 29)).toEqual([77, 77, 77, 77]);
    // Nothing past the store's own bound was touched — toPixels() would throw/mismatch length
    // if writeRegion had written outside the allocated tiles.
    expect(store.toPixels().length).toBe(w * h * 4);
  });

  it("a no-op write (fully outside the store) leaves every tile untouched", () => {
    const w = 30, h = 30;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    store.writeRegion({ x: 100, y: 100, width: 10, height: 10 }, new Uint8ClampedArray(10 * 10 * 4).fill(9), 10);
    expect([...store.toPixels()]).toEqual([...source]);
  });
});

describe("TileStore.writeLocalRegion / readLocalRegion — the rect-local shape a GIMP-style undo patch actually has", () => {
  it("readLocalRegion matches readPixel across the region, addressed from its own (0,0)", () => {
    const w = TILE_SIZE * 2 + 10, h = TILE_SIZE + 5;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    const rect = { x: TILE_SIZE - 3, y: 2, width: 30, height: 20 };
    const region = store.readLocalRegion(rect);
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) {
        const index = (y * rect.width + x) * 4;
        expect([region[index], region[index + 1], region[index + 2], region[index + 3]]).toEqual(store.readPixel(rect.x + x, rect.y + y));
      }
    }
  });

  it("readLocalRegion reaching past the store's edge reads the overhang as transparent", () => {
    const w = 20, h = 20;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    const region = store.readLocalRegion({ x: 15, y: 15, width: 10, height: 10 });
    // (15,15)..(19,19) is real content; (20,20)..(24,24) overhangs past the store.
    const insideIndex = (0 * 10 + 0) * 4, outsideIndex = (9 * 10 + 9) * 4;
    expect(region[insideIndex + 3]).not.toBe(0);
    expect([region[outsideIndex], region[outsideIndex + 1], region[outsideIndex + 2], region[outsideIndex + 3]]).toEqual([0, 0, 0, 0]);
  });

  it("writeLocalRegion writes a rect-local patch, matching writeRegion given the same content re-shaped", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE * 2;
    const rect = { x: TILE_SIZE - 8, y: TILE_SIZE - 8, width: 30, height: 30 };
    const local = new Uint8ClampedArray(rect.width * rect.height * 4);
    for (let i = 0; i < local.length; i += 1) local[i] = (i * 29 + 17) % 256;

    const a = TileStore.fromPixels(fixture(w, h), w, h);
    a.writeLocalRegion(rect, local);

    // The same patch, re-shaped to writeRegion's store-shaped contract, on an identical source.
    const storeSized = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < rect.height; y += 1) {
      const from = y * rect.width * 4, to = ((rect.y + y) * w + rect.x) * 4;
      storeSized.set(local.subarray(from, from + rect.width * 4), to);
    }
    const b = TileStore.fromPixels(fixture(w, h), w, h);
    b.writeRegion(rect, storeSized, w);

    expect([...a.toPixels()]).toEqual([...b.toPixels()]);
  });

  it("writeLocalRegion only replaces the tiles the region overlaps — CoW holds at tile granularity", () => {
    const w = TILE_SIZE * 3, h = TILE_SIZE;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    const clone = store.clone();
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    clone.writeLocalRegion(rect, new Uint8ClampedArray(rect.width * rect.height * 4).fill(90));
    expect(clone.readPixel(5, 5)).toEqual([90, 90, 90, 90]);
    expect(store.readPixel(5, 5)).not.toEqual([90, 90, 90, 90]);
    // The untouched tiles (columns 1 and 2) are still the exact same objects on both stores.
    const seen = new Set<Uint8ClampedArray>();
    store.uniqueBytes(seen);
    expect(clone.uniqueBytes(seen)).toBe(TILE_SIZE * TILE_SIZE * 4); // only the touched tile is new
  });

  it("round-trips a mask-shaped (channels: 1) region through write then read", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE;
    const store = TileStore.fromPixels(new Uint8ClampedArray(w * h), w, h, 1);
    const rect = { x: TILE_SIZE - 4, y: 3, width: 12, height: 9 };
    const patch = new Uint8ClampedArray(rect.width * rect.height);
    for (let i = 0; i < patch.length; i += 1) patch[i] = (i * 7 + 1) % 256;
    store.writeLocalRegion(rect, patch);
    expect([...store.readLocalRegion(rect)]).toEqual([...patch]);
  });
});

describe("TileStore.uniqueBytes", () => {
  it("counts a fresh store's tiles once, and a clone's shared tiles zero times more", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE * 2;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    const seen = new Set<Uint8ClampedArray>();
    const first = store.uniqueBytes(seen);
    expect(first).toBe(w * h * 4);

    const clone = store.clone();
    // Nothing new: every tile clone() shares is already in `seen`.
    expect(clone.uniqueBytes(seen)).toBe(0);
  });

  it("a clone's own written tiles count as new bytes, its untouched tiles do not", () => {
    const w = TILE_SIZE * 3, h = TILE_SIZE;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    const seen = new Set<Uint8ClampedArray>();
    store.uniqueBytes(seen);

    const clone = store.clone();
    clone.writeRegion({ x: 0, y: 0, width: 10, height: 10 }, new Uint8ClampedArray(10 * 10 * 4), 10);
    // Exactly one tile (the one the write touched) was replaced with a new array.
    expect(clone.uniqueBytes(seen)).toBe(TILE_SIZE * TILE_SIZE * 4);
  });
});

/** A reference crop/pad over a flat buffer — the same convention `cropToRect`/`growToInclude`
 *  already use: `(dx, dy)` names this store's own coordinates that land at the new frame's (0,0),
 *  and anything the new frame reaches outside the source buffer reads as transparent. */
function referenceReframe(source: Uint8ClampedArray, sourceWidth: number, sourceHeight: number, dx: number, dy: number, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = y + dy;
    if (sourceY < 0 || sourceY >= sourceHeight) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x + dx;
      if (sourceX < 0 || sourceX >= sourceWidth) continue;
      const from = (sourceY * sourceWidth + sourceX) * 4, to = (y * width + x) * 4;
      out[to] = source[from]!; out[to + 1] = source[from + 1]!; out[to + 2] = source[from + 2]!; out[to + 3] = source[from + 3]!;
    }
  }
  return out;
}

describe("TileStore.reframe", () => {
  it("crops to a smaller, tile-unaligned rectangle fully inside the store — trimInPlace's own shape", () => {
    const w = TILE_SIZE * 2 + 10, h = TILE_SIZE * 2 + 3;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    const dx = 17, dy = 9, width = TILE_SIZE + 30, height = TILE_SIZE + 5;
    const reference = referenceReframe(source, w, h, dx, dy, width, height);
    expect([...store.reframe(dx, dy, width, height).toPixels()]).toEqual([...reference]);
  });

  it("pads to a larger rectangle anchored at a positive offset — growToInclude's own shape", () => {
    const w = 40, h = 30;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    // The old content lands at (dx, dy) inside the new, bigger frame — negative dx/dy, the same
    // sign growToInclude passes when the grown rect extends up/left of the original bounds.
    const dx = -15, dy = -8, width = w + 50, height = h + 40;
    const reference = referenceReframe(source, w, h, dx, dy, width, height);
    expect([...store.reframe(dx, dy, width, height).toPixels()]).toEqual([...reference]);
    // The padding itself must actually be transparent, not garbage from an uninitialised tile.
    expect(store.reframe(dx, dy, width, height).readPixel(0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("a same-size, zero-offset reframe is the identity", () => {
    const w = TILE_SIZE + 5, h = TILE_SIZE * 2;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    expect([...store.reframe(0, 0, w, h).toPixels()]).toEqual([...source]);
  });

  it("a frame entirely outside the source reads back entirely transparent", () => {
    const store = TileStore.fromPixels(fixture(20, 20), 20, 20);
    const reframed = store.reframe(1000, 1000, 20, 20);
    expect([...reframed.toPixels()]).toEqual([...new Uint8ClampedArray(20 * 20 * 4)]);
  });

  it("matches a reference crop/pad for an offset that is not a multiple of TILE_SIZE", () => {
    const w = TILE_SIZE * 3, h = TILE_SIZE * 2;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    const dx = 23, dy = -11, width = TILE_SIZE * 2 + 40, height = TILE_SIZE + 60;
    const reference = referenceReframe(source, w, h, dx, dy, width, height);
    expect([...store.reframe(dx, dy, width, height).toPixels()]).toEqual([...reference]);
  });

  it("shares full interior tiles by reference on a tile-aligned shift, and keeps the two stores independent afterward", () => {
    const w = TILE_SIZE * 4, h = TILE_SIZE * 4;
    const store = TileStore.fromPixels(fixture(w, h), w, h);
    // Shifting by exactly one tile in each direction is the fast path: every full destination
    // tile away from the new frame's own edges should borrow its source tile outright.
    const reframed = store.reframe(TILE_SIZE, TILE_SIZE, w, h);
    expect([...reframed.toPixels()]).toEqual([...referenceReframe(store.toPixels(), w, h, TILE_SIZE, TILE_SIZE, w, h)]);

    // Writing to the *source* after reframing must not leak into the reframed store's shared
    // tiles — the same CoW contract `clone()` already guarantees, now exercised through reframe.
    const beforeWrite = reframed.toPixels();
    store.writeRegion({ x: TILE_SIZE * 2, y: TILE_SIZE * 2, width: 10, height: 10 }, new Uint8ClampedArray(10 * 10 * 4).fill(255), 10);
    expect([...reframed.toPixels()]).toEqual([...beforeWrite]);

    // And the reverse: writing to the reframed store must not disturb the original.
    const beforeSourceWrite = store.toPixels();
    reframed.writeRegion({ x: TILE_SIZE, y: TILE_SIZE, width: 10, height: 10 }, new Uint8ClampedArray(10 * 10 * 4).fill(128), 10);
    expect([...store.toPixels()]).toEqual([...beforeSourceWrite]);
  });

  it("rebuilds edge tiles instead of borrowing a wrong-sized source tile on a tile-aligned shift", () => {
    // The store's own edge tiles are smaller than TILE_SIZE. A tile-aligned shift that lines a
    // destination's full-size tile up with one of those undersized source tiles must not borrow
    // it outright — it has the wrong length for the destination tile it would be assigned to.
    const w = TILE_SIZE + 10, h = TILE_SIZE + 10;
    const source = fixture(w, h);
    const store = TileStore.fromPixels(source, w, h);
    const width = TILE_SIZE * 2, height = TILE_SIZE * 2;
    const reference = referenceReframe(source, w, h, -TILE_SIZE, -TILE_SIZE, width, height);
    expect([...store.reframe(-TILE_SIZE, -TILE_SIZE, width, height).toPixels()]).toEqual([...reference]);
  });
});

/** A deterministic, non-uniform single-channel buffer — `RasterLayerMask.pixels`'s own shape
 *  (one grayscale byte per pixel, no alpha/colour channels), the reason `channels` exists at all. */
function maskFixture(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 53 + 7) % 256;
  return pixels;
}

describe("TileStore with channels: 1 (a mask-shaped store)", () => {
  it("round-trips a mask-shaped buffer, edges and all", () => {
    const w = TILE_SIZE + 9, h = TILE_SIZE * 2 + 5;
    const source = maskFixture(w, h);
    expect([...TileStore.fromPixels(source, w, h, 1).toPixels()]).toEqual([...source]);
  });

  it("rejects a buffer sized for the wrong channel count", () => {
    // The same buffer that fromPixels(..., 4) would happily accept is the wrong length at
    // channels: 1 — this is the exact mismatch that made `TileStore` unusable for masks until
    // `channels` existed, so it stays a hard error rather than silently misreading the tiling.
    const rgbaSized = new Uint8ClampedArray(4 * 4 * 4);
    expect(() => TileStore.fromPixels(rgbaSized, 4, 4, 1)).toThrow(RangeError);
  });

  it("readPixel returns one value, not a padded RGBA tuple", () => {
    const w = TILE_SIZE + 3, h = TILE_SIZE;
    const source = maskFixture(w, h);
    const store = TileStore.fromPixels(source, w, h, 1);
    for (const [x, y] of [[0, 0], [w - 1, h - 1], [TILE_SIZE, 0], [TILE_SIZE - 1, TILE_SIZE - 1]]) {
      expect(store.readPixel(x!, y!)).toEqual([source[y! * w + x!]]);
    }
    expect(store.readPixel(-1, 0)).toEqual([0]);
  });

  it("writeRegion touches only the tiles the region overlaps, at one byte per pixel", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE * 2;
    const store = TileStore.fromPixels(maskFixture(w, h), w, h, 1);
    const rect = { x: TILE_SIZE - 5, y: TILE_SIZE - 5, width: 20, height: 20 };
    const patch = new Uint8ClampedArray(w * h);
    for (let y = rect.y; y < rect.y + rect.height; y += 1) for (let x = rect.x; x < rect.x + rect.width; x += 1) patch[y * w + x] = 200;
    store.writeRegion(rect, patch, w);
    expect(store.readPixel(rect.x, rect.y)).toEqual([200]);
    expect(store.readPixel(0, 0)).toEqual([maskFixture(w, h)[0]]);
  });

  it("keeps the CoW contract at one byte per pixel: a clone's write never touches its source", () => {
    const w = TILE_SIZE * 2, h = TILE_SIZE * 2;
    const source = maskFixture(w, h);
    const store = TileStore.fromPixels(source, w, h, 1);
    const clone = store.clone();
    clone.writeRegion({ x: 0, y: 0, width: 10, height: 10 }, new Uint8ClampedArray(w * h).fill(255), w);
    expect([...store.toPixels()]).toEqual([...source]);
    expect(clone.readPixel(5, 5)).toEqual([255]);
  });

  it("reframe crops/pads a mask-shaped store the same way as an RGBA one", () => {
    const w = TILE_SIZE * 2 + 4, h = TILE_SIZE + 6;
    const source = maskFixture(w, h);
    const store = TileStore.fromPixels(source, w, h, 1);
    const dx = -12, dy = 8, width = TILE_SIZE * 2, height = TILE_SIZE;
    const reframed = store.reframe(dx, dy, width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceX = x + dx, sourceY = y + dy;
        const expected = sourceX >= 0 && sourceX < w && sourceY >= 0 && sourceY < h ? source[sourceY * w + sourceX]! : 0;
        expect(reframed.readPixel(x, y)).toEqual([expected]);
      }
    }
  });
});

/**
 * docs/master-plan.md §37.3 item 6 (tile swap beyond RAM) — `placeholder()` is the marker a
 * layer's `tiles` field is set to once its real bytes are persisted elsewhere and freed from the
 * JS heap. Every method that would need real pixel data must fail loudly (`EvictedTileStoreError`)
 * rather than fabricate content — see that class's own doc comment for why a quiet zero-fill would
 * be the wrong choice here specifically, unlike an ordinary out-of-bounds read.
 */
describe("TileStore.placeholder — the swap-eviction marker", () => {
  it("reports the right shape without allocating any tile", () => {
    const store = TileStore.placeholder(500, 400, 4);
    expect(store.width).toBe(500);
    expect(store.height).toBe(400);
    expect(store.channels).toBe(4);
    expect(store.evicted).toBe(true);
    expect([...store.tileBuffers()]).toEqual([]);
    expect(store.uniqueBytes(new Set())).toBe(0);
  });

  it("a freshly built (non-placeholder) store reports evicted: false", () => {
    expect(TileStore.fromPixels(new Uint8ClampedArray(4 * 4 * 4), 4, 4).evicted).toBe(false);
    expect(TileStore.empty(4, 4).evicted).toBe(false);
  });

  it.each([
    ["toPixels", (store: TileStore) => store.toPixels()],
    ["readPixel", (store: TileStore) => store.readPixel(0, 0)],
    ["readLocalRegion", (store: TileStore) => store.readLocalRegion({ x: 0, y: 0, width: 1, height: 1 })],
    ["writeRegion", (store: TileStore) => store.writeRegion({ x: 0, y: 0, width: 1, height: 1 }, new Uint8ClampedArray(4), 1)],
    ["writeLocalRegion", (store: TileStore) => store.writeLocalRegion({ x: 0, y: 0, width: 1, height: 1 }, new Uint8ClampedArray(4))],
    ["reframe", (store: TileStore) => store.reframe(0, 0, 4, 4)],
  ] as const)("%s throws EvictedTileStoreError instead of fabricating content", (_name, operate) => {
    const store = TileStore.placeholder(4, 4, 4);
    expect(() => operate(store)).toThrow(/evicted/i);
  });

  it("clone() of a placeholder stays a placeholder, cheaply, rather than throwing", () => {
    const clone = TileStore.placeholder(8, 8, 4).clone();
    expect(clone.evicted).toBe(true);
    expect(() => clone.toPixels()).toThrow(/evicted/i);
  });

  /**
   * `toJSON()`/`fromJSON()` are the one pair of methods that do NOT throw for an evicted store —
   * found live, the hard way: `document-snapshot-store.ts`'s autosave calls `toJSON()` on every
   * layer of every open document on its own idle timer, with no way to ask "is this evicted" first,
   * and a thrown `EvictedTileStoreError` there surfaced as an unhandled promise rejection the moment
   * any layer was evicted. `toJSON()` is describing state, not fabricating pixels to use — "I am
   * currently evicted" is a real, round-trippable answer.
   */
  it("toJSON()/fromJSON() round-trip an evicted store as still evicted, not as a crash", () => {
    const placeholder = TileStore.placeholder(12, 9, 4);
    const snapshot = placeholder.toJSON();
    expect(snapshot).toEqual({ width: 12, height: 9, channels: 4, evicted: true });
    expect("pixels" in snapshot).toBe(false);

    const restored = TileStore.fromJSON(snapshot);
    expect(restored.evicted).toBe(true);
    expect(restored.width).toBe(12);
    expect(restored.height).toBe(9);
    expect(restored.channels).toBe(4);
  });

  it("toJSON() on a real (non-evicted) store is unaffected — still the plain pixels shape", () => {
    const source = new Uint8ClampedArray([1, 2, 3, 4]);
    const snapshot = TileStore.fromPixels(source, 1, 1).toJSON();
    expect("evicted" in snapshot).toBe(false);
    expect([...(snapshot as { pixels: Uint8ClampedArray }).pixels]).toEqual([1, 2, 3, 4]);
  });
});
