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
