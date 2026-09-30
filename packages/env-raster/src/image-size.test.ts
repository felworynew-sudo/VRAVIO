import { describe, expect, it } from "vitest";
import { createRasterDocument, createRasterLayerMaskFromSelection } from "./document";
import { canvasSizeRect, resizeRasterCanvas, resizeRasterDocument } from "./image-size";
import { layerDocumentPixels, setLayerLocalPixels, setLayerPixels } from "./layer-bounds";
import { createRectangleSelection } from "./selection";

/** §65.13 — Image ▸ Image Size and Image ▸ Canvas Size. */
const solid = (width: number, height: number, rgba: readonly number[]) => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) pixels.set(rgba, i * 4);
  return pixels;
};

describe("resizeRasterDocument (Image Size, Resample on)", () => {
  it("scales the canvas and every layer in its own frame", () => {
    const state = createRasterDocument(100, 80);
    const layer = state.layers[0]!;
    setLayerLocalPixels(layer, solid(20, 20, [200, 50, 50, 255]), { x: 10, y: 10, width: 20, height: 20 });
    const next = resizeRasterDocument(state, 50, 40, "bicubic");
    expect([next.width, next.height]).toEqual([50, 40]);
    expect(next.layers[0]!.bounds).toEqual({ x: 5, y: 5, width: 10, height: 10 });
    // The original is untouched: the resize returns a new document.
    expect(state.layers[0]!.bounds).toEqual({ x: 10, y: 10, width: 20, height: 20 });
  });

  it("scales what a layer holds past the canvas instead of dropping it", () => {
    const state = createRasterDocument(100, 100);
    setLayerLocalPixels(state.layers[0]!, solid(60, 20, [0, 0, 255, 255]), { x: -40, y: 0, width: 60, height: 20 });
    const next = resizeRasterDocument(state, 200, 200, "bilinear");
    expect(next.layers[0]!.bounds).toEqual({ x: -80, y: 0, width: 120, height: 40 });
  });

  it("scales the selection and a layer mask with the pixels", () => {
    const state = createRasterDocument(100, 100);
    const selection = createRectangleSelection(100, 100, 20, 20, 60, 60);
    state.selection = selection;
    state.layers[0]!.mask = createRasterLayerMaskFromSelection(selection, 100, 100);
    const next = resizeRasterDocument(state, 50, 50, "bilinear");
    // A filtered edge inside the canvas may leave at most a one-pixel antialiased fringe.
    const { bounds, mask: selected } = next.selection!;
    expect(Math.abs(bounds.x - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.x + bounds.width - 30)).toBeLessThanOrEqual(1);
    expect(selected[15 * 50 + 15]).toBe(255);
    expect(selected[5 * 50 + 5]).toBe(0);
    const mask = next.layers[0]!.mask!.tiles.toPixels();
    expect(mask.length).toBe(50 * 50);
    expect(mask[15 * 50 + 15]).toBe(255);
    expect(mask[5 * 50 + 5]).toBe(0);
  });
});

describe("resizeRasterCanvas (Canvas Size)", () => {
  it("places the old canvas by the anchor", () => {
    expect(canvasSizeRect(100, 80, 120, 100, [0, 0])).toEqual({ x: -10, y: -10, width: 120, height: 100 });
    expect(canvasSizeRect(100, 80, 120, 100, [-1, -1])).toEqual({ x: 0, y: 0, width: 120, height: 100 });
    expect(canvasSizeRect(100, 80, 120, 100, [1, 1])).toEqual({ x: -20, y: -20, width: 120, height: 100 });
  });

  it("grows around the centre, moves layers without resampling, and fills the new area of the bottom layer", () => {
    const state = createRasterDocument(100, 80);
    setLayerPixels(state.layers[0]!, solid(100, 80, [10, 20, 30, 255]), 100, 80);
    const next = resizeRasterCanvas(state, 120, 100, [0, 0], [255, 255, 255, 255]);
    expect([next.width, next.height]).toEqual([120, 100]);
    const pixels = layerDocumentPixels(next.layers[0]!, 120, 100);
    const at = (x: number, y: number) => Array.from(pixels.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 4));
    expect(at(0, 0)).toEqual([255, 255, 255, 255]);
    expect(at(10, 10)).toEqual([10, 20, 30, 255]);
    expect(at(109, 89)).toEqual([10, 20, 30, 255]);
    expect(at(110, 90)).toEqual([255, 255, 255, 255]);
  });

  it("leaves new canvas transparent without an extension colour, and keeps what a shrink leaves outside", () => {
    const state = createRasterDocument(100, 100);
    setLayerPixels(state.layers[0]!, solid(100, 100, [9, 9, 9, 255]), 100, 100);
    const grown = resizeRasterCanvas(state, 140, 100, [-1, 0], null);
    expect(layerDocumentPixels(grown.layers[0]!, 140, 100)[(50 * 140 + 120) * 4 + 3]).toBe(0);
    const shrunk = resizeRasterCanvas(state, 50, 50, [0, 0], null);
    expect(shrunk.layers[0]!.bounds).toEqual({ x: -25, y: -25, width: 100, height: 100 });
  });
});
