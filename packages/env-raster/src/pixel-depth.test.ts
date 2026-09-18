import { describe, expect, it } from "vitest";
import { bufferDepth, bytesPerPixel, convertPixelDepth, depthMaximum, fromRgba8, toRgba8 } from "./pixel-format";
import { TILE_SIZE, TileStore } from "./tile-store";

/**
 * docs/master-plan.md §59.2, slice 1: storage carries a depth, and the 8-bit view every existing
 * caller asks for keeps working at every depth.
 *
 * The cases that matter are the ones where being off by a hair is silent: white must stay exactly
 * white through a depth change (the ×257 vs ×256 trap), an upward conversion must be reversible,
 * and 32-bit must keep the out-of-range values that are its only reason to exist.
 */

describe("depth conversion", () => {
  it("promotes 8 → 16 so that white stays white and the round trip is the identity", () => {
    const source = new Uint8ClampedArray([0, 1, 127, 128, 254, 255, 171, 0]);
    const deep = convertPixelDepth(source, 8, 16);

    // ×257, not ×256: 255 * 256 = 65280 would make white slightly grey, and every subsequent
    // conversion would drift further. 0xAB becomes 0xABAB — babl's own replication.
    expect(Array.from(deep)).toEqual([0, 257, 32639, 32896, 65278, 65535, 43947, 0]);
    expect(Array.from(convertPixelDepth(deep, 16, 8))).toEqual(Array.from(source));
  });

  it("promotes 8 → 32 to 0…1 and back without loss", () => {
    const source = new Uint8ClampedArray([0, 64, 128, 255]);
    const float = convertPixelDepth(source, 8, 32);

    expect(float[3]).toBe(1);
    expect(Array.from(convertPixelDepth(float, 32, 8))).toEqual([0, 64, 128, 255]);
  });

  it("keeps 32-bit values above 1 — the whole point of float storage — until something asks for 8 bits", () => {
    const highlights = new Float32Array([2.5, -0.25, 0.5, 1]);

    // Stored as they are; only the 8-bit view clips, because 8 bits has nowhere to put them.
    expect(highlights[0]).toBe(2.5);
    expect(Array.from(toRgba8(highlights))).toEqual([255, 0, 128, 255]);
  });

  it("knows a buffer's depth from the buffer itself, with no field to fall out of sync", () => {
    expect(bufferDepth(new Uint8ClampedArray(4))).toBe(8);
    expect(bufferDepth(new Uint16Array(4))).toBe(16);
    expect(bufferDepth(new Float32Array(4))).toBe(32);
    expect([depthMaximum(8), depthMaximum(16), depthMaximum(32)]).toEqual([255, 65535, 1]);
    expect([bytesPerPixel(8), bytesPerPixel(16), bytesPerPixel(32)]).toEqual([4, 8, 16]);
  });

  it("copies rather than aliases, even when the depth already matches", () => {
    const source = new Uint8ClampedArray([1, 2, 3, 4]);
    const copy = convertPixelDepth(source, 8, 8);
    copy[0] = 99;

    expect(source[0]).toBe(1);
  });
});

describe("a TileStore at 16 and 32 bits", () => {
  const fixture = (width: number, height: number) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 37) % 256;
    return pixels;
  };

  it("holds its tiles in the declared depth and hands back the 8-bit view unchanged", () => {
    const pixels = fixture(TILE_SIZE + 5, TILE_SIZE + 3);
    const deep = TileStore.fromPixels(pixels, TILE_SIZE + 5, TILE_SIZE + 3, 4, 16);

    expect(deep.depth).toBe(16);
    expect(deep.toPixelsDeep()).toBeInstanceOf(Uint16Array);
    // The promotion is exact, so the 8-bit view of a promoted store is the original buffer.
    expect(Array.from(deep.toPixels())).toEqual(Array.from(pixels));
  });

  it("accepts an 8-bit write into a 16-bit store, converting at the boundary", () => {
    const deep = TileStore.empty(TILE_SIZE, TILE_SIZE, 4, 16);
    const patch = new Uint8ClampedArray(2 * 2 * 4).fill(255);
    deep.writeLocalRegion({ x: 3, y: 4, width: 2, height: 2 }, patch);

    // 255 arrived as 65535, not as 255 sitting in a 16-bit slot (which would be near-black).
    expect(deep.readPixel(3, 4)).toEqual([65535, 65535, 65535, 65535]);
    expect(Array.from(deep.readLocalRegion({ x: 3, y: 4, width: 1, height: 1 }))).toEqual([255, 255, 255, 255]);
  });

  it("converts a whole store between depths and survives the save/restore round trip", () => {
    const pixels = fixture(TILE_SIZE, TILE_SIZE);
    const eight = TileStore.fromPixels(pixels, TILE_SIZE, TILE_SIZE);
    const float = eight.withDepth(32);

    expect(float.depth).toBe(32);
    expect(float.toPixelsDeep()).toBeInstanceOf(Float32Array);
    // The snapshot carries the depth and the deep buffer: a save that wrote the 8-bit view would
    // silently turn every deep document back into an 8-bit one on the next session restore.
    const restored = TileStore.fromJSON(float.toJSON() as never);
    expect(restored.depth).toBe(32);
    expect(Array.from(restored.toPixels())).toEqual(Array.from(pixels));
  });

  it("keeps the depth through clone, reframe and eviction", () => {
    const deep = TileStore.fromPixels(fixture(TILE_SIZE, TILE_SIZE), TILE_SIZE, TILE_SIZE, 4, 16);

    expect(deep.clone().depth).toBe(16);
    expect(deep.reframe(-8, -8, TILE_SIZE, TILE_SIZE).depth).toBe(16);
    expect(TileStore.placeholder(4, 4, 4, 32).depth).toBe(32);
  });

  it("costs what the depth says it costs", () => {
    const eight = TileStore.fromPixels(fixture(TILE_SIZE, TILE_SIZE), TILE_SIZE, TILE_SIZE);
    const sixteen = eight.withDepth(16);

    expect(sixteen.uniqueBytes(new Set())).toBe(eight.uniqueBytes(new Set()) * 2);
  });

  it("round-trips an 8-bit buffer through fromRgba8/toRgba8 at every depth", () => {
    const source = new Uint8ClampedArray([0, 77, 200, 255]);
    for (const depth of [8, 16, 32] as const) {
      expect(Array.from(toRgba8(fromRgba8(source, depth))), `depth ${depth}`).toEqual([0, 77, 200, 255]);
    }
  });
});
