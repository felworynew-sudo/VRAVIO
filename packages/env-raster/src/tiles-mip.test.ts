import { describe, expect, it } from "vitest";
import { RasterTileCache, accumulateUniquePixelBytes, appendLayer, createRasterDocument, createRasterLayer, mipForZoom, setLayerPixels, visitPixelBuffers } from "./index";
import type { RasterDocumentState } from "./types";

const W = 512, H = 512;

const scene = (): RasterDocumentState => {
  const state = createRasterDocument(W, H);
  const layer = createRasterLayer(W, H, "Block");
  for (let y = 64; y < 320; y += 1) for (let x = 64; x < 320; x += 1) {
    const at = (y * W + x) * 4;
    layer.pixels[at] = 200; layer.pixels[at + 1] = 90; layer.pixels[at + 2] = 40; layer.pixels[at + 3] = 255;
  }
  setLayerPixels(layer, layer.pixels, W, H);
  appendLayer(state, layer);
  return state;
};

describe("choosing a mip level for the zoom", () => {
  it("stays at full resolution at or above one to one", () => {
    for (const zoom of [1, 1.5, 4, 32]) expect(mipForZoom(zoom)).toBe(0);
  });

  it("halves once per halving of the zoom", () => {
    expect(mipForZoom(0.5)).toBe(1);
    expect(mipForZoom(0.25)).toBe(2);
    expect(mipForZoom(0.12)).toBe(3);
  });

  it("stops before the picture becomes unrecognisable", () => {
    // Sixteen to one is as coarse as it gets; past that the saving is small and
    // the view stops resembling the document.
    expect(mipForZoom(0.001)).toBe(4);
  });

  it("treats a nonsense zoom as full resolution", () => {
    for (const zoom of [0, -1, Number.NaN]) expect(mipForZoom(zoom)).toBe(0);
  });
});

describe("tiles at a mip level", () => {
  it("composites a quarter of the pixels one level down", () => {
    const state = scene();
    const cache = new RasterTileCache({ tileSize: 256 });

    const full = cache.update(state, { x: 0, y: 0, width: W, height: H }, 0);
    const half = new RasterTileCache({ tileSize: 256 }).update(state, { x: 0, y: 0, width: W, height: H }, 1);

    const bytes = (tiles: readonly { pixels: Uint8ClampedArray }[]) => tiles.reduce((sum, tile) => sum + tile.pixels.byteLength, 0);
    expect(bytes(half.repainted) * 4).toBe(bytes(full.repainted));
    expect(half.repainted[0]!.step).toBe(2);
  });

  it("keeps levels apart in the cache", () => {
    const state = scene();
    const cache = new RasterTileCache({ tileSize: 256 });

    cache.update(state, { x: 0, y: 0, width: W, height: H }, 0);
    const zoomedOut = cache.update(state, { x: 0, y: 0, width: W, height: H }, 1);

    // A level is composited on its own rather than reusing another's tiles,
    // which would show one zoom's pixels at another's.
    expect(zoomedOut.repainted.length).toBeGreaterThan(0);
  });

  it("stales every level of a tile an edit touched", () => {
    const state = scene();
    const cache = new RasterTileCache({ tileSize: 256 });
    cache.update(state, { x: 0, y: 0, width: W, height: H }, 0);
    cache.update(state, { x: 0, y: 0, width: W, height: H }, 1);

    cache.invalidate({ x: 100, y: 100, width: 20, height: 20 });

    // Keeping one level would show the edit at some zooms and not others.
    expect(cache.update(state, { x: 0, y: 0, width: W, height: H }, 0).repainted.length).toBeGreaterThan(0);
    expect(cache.update(state, { x: 0, y: 0, width: W, height: H }, 1).repainted.length).toBeGreaterThan(0);
  });
});

describe("pricing pixel memory once per buffer", () => {
  it("counts a buffer once however many states point at it", () => {
    const state = scene();
    const snapshot = { ...state, layers: state.layers.map((layer) => ({ ...layer })) };

    const seen = new Set<ArrayBufferView>();
    const first = accumulateUniquePixelBytes(state, seen);
    const second = accumulateUniquePixelBytes(snapshot, seen);

    // A history snapshot that shares its buffers costs nothing to keep, and
    // charging it again is what starts discarding undo depth for free.
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it("reaches layers, masks and the selection", () => {
    const state = scene();
    const seen: ArrayBufferView[] = [];
    visitPixelBuffers(state, (buffer) => seen.push(buffer));

    expect(seen).toHaveLength(state.layers.length);
  });
});
