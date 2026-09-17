import { describe, expect, it } from "vitest";
import { createRasterDocument, cropRasterDocument, layerDocumentPixels, setLayerPixels, translateLayerOrigin } from "./index";
import type { RasterLayer } from "./types";

/** Alpha at a document coordinate, read straight from the layer's own buffer — including
 * coordinates outside the document, which `layerDocumentPixels` cannot show. */
function alphaAt(layer: RasterLayer, x: number, y: number): number {
  const localX = x - layer.bounds.x, localY = y - layer.bounds.y;
  if (localX < 0 || localY < 0 || localX >= layer.bounds.width || localY >= layer.bounds.height) return 0;
  return layer.tiles.readPixel(localX, localY)[3] ?? 0;
}

/** A 100×100 opaque layer cropped to the 50×50 centre with Delete Cropped Pixels off: the layer
 * now reaches 25 px past every edge of the new canvas. */
function croppedKeepingPixels() {
  const document = createRasterDocument(100, 100);
  setLayerPixels(document.layers[0]!, new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100);
  const cropped = cropRasterDocument(document, { x: 25, y: 25, width: 50, height: 50 }, false);
  return { state: cropped, layer: cropped.layers[0]! };
}

describe("setLayerPixels keepOutsideDocument", () => {
  it("a hinted stroke on a layer that reaches past the canvas keeps what is outside", () => {
    const { layer } = croppedKeepingPixels();
    expect(layer.bounds).toEqual({ x: -25, y: -25, width: 100, height: 100 });
    const edited = layerDocumentPixels(layer, 50, 50).slice();
    edited[3] = 0;
    setLayerPixels(layer, edited, 50, 50, { bounds: { x: 0, y: 0, width: 1, height: 1 }, canShrink: false }, { keepOutsideDocument: true });
    expect(layer.bounds).toEqual({ x: -25, y: -25, width: 100, height: 100 });
    expect(alphaAt(layer, -25, -25)).toBe(255);
    expect(alphaAt(layer, 74, 74)).toBe(255);
    expect(alphaAt(layer, 0, 0)).toBe(0);
    expect(alphaAt(layer, 1, 0)).toBe(255);
  });

  it("an unhinted edit that erases the whole canvas trims to what is left outside it", () => {
    const { layer } = croppedKeepingPixels();
    setLayerPixels(layer, new Uint8ClampedArray(50 * 50 * 4), 50, 50, null, { keepOutsideDocument: true });
    expect(layer.bounds).toEqual({ x: -25, y: -25, width: 100, height: 100 });
    expect(alphaAt(layer, 10, 10)).toBe(0);
    expect(alphaAt(layer, -1, 10)).toBe(255);
    expect(layer.tiles.width * layer.tiles.height).toBe(layer.bounds.width * layer.bounds.height);
  });

  it("trims away the canvas side when only one edge's overhang survives", () => {
    const document = createRasterDocument(100, 100);
    const layer = document.layers[0]!;
    const full = new Uint8ClampedArray(100 * 100 * 4);
    for (let y = 0; y < 100; y += 1) for (let x = 0; x < 40; x += 1) full[(y * 100 + x) * 4 + 3] = 255;
    setLayerPixels(layer, full, 100, 100);
    const cropped = cropRasterDocument(document, { x: 20, y: 0, width: 80, height: 100 }, false).layers[0]!;
    expect(cropped.bounds).toEqual({ x: -20, y: 0, width: 40, height: 100 });
    setLayerPixels(cropped, new Uint8ClampedArray(80 * 100 * 4), 80, 100, null, { keepOutsideDocument: true });
    expect(cropped.bounds).toEqual({ x: -20, y: 0, width: 20, height: 100 });
  });

  it("does not share written tiles with a clone taken before the edit", () => {
    const { state, layer } = croppedKeepingPixels();
    const snapshot = layer.tiles;
    setLayerPixels(layer, new Uint8ClampedArray(50 * 50 * 4), 50, 50, null, { keepOutsideDocument: true });
    expect(state.layers[0]).toBe(layer);
    expect(snapshot.readPixel(30, 30)[3]).toBe(255);
  });

  it("changes nothing for a layer that lies inside the canvas", () => {
    const a = createRasterDocument(40, 40).layers[0]!, b = createRasterDocument(40, 40).layers[0]!;
    const pixels = new Uint8ClampedArray(40 * 40 * 4);
    for (let y = 5; y < 15; y += 1) for (let x = 8; x < 20; x += 1) pixels[(y * 40 + x) * 4 + 3] = 200;
    setLayerPixels(a, pixels, 40, 40);
    setLayerPixels(b, pixels, 40, 40, null, { keepOutsideDocument: true });
    expect(b.bounds).toEqual(a.bounds);
    expect(b.tiles.toPixels()).toEqual(a.tiles.toPixels());
  });

  it("without the option a regenerating write still replaces the layer outright", () => {
    const { layer } = croppedKeepingPixels();
    setLayerPixels(layer, new Uint8ClampedArray(50 * 50 * 4).fill(255), 50, 50);
    expect(layer.bounds).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });
});

describe("translateLayerOrigin", () => {
  it("moving a layer over the edge and back loses nothing", () => {
    const document = createRasterDocument(100, 100);
    const layer = document.layers[0]!;
    setLayerPixels(layer, new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100);
    translateLayerOrigin(layer, 40, 0);
    expect(layer.bounds).toEqual({ x: 40, y: 0, width: 100, height: 100 });
    translateLayerOrigin(layer, -40, 0);
    expect(layer.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(alphaAt(layer, 99, 50)).toBe(255);
  });

  it("moves a type layer's description with its pixels", () => {
    const layer = createRasterDocument(50, 50).layers[0]!;
    layer.text = { value: "A", x: 10, y: 12, visualBounds: { x: 8, y: 9, width: 5, height: 6 } } as NonNullable<RasterLayer["text"]>;
    translateLayerOrigin(layer, 3, -4);
    expect(layer.text!.x).toBe(13);
    expect(layer.text!.y).toBe(8);
    expect(layer.text!.visualBounds).toEqual({ x: 11, y: 5, width: 5, height: 6 });
  });
});
