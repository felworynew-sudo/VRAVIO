import { describe, expect, it } from "vitest";
import { compositeRasterRegion, createRasterDocument, createRasterLayer, createRasterLayerMask, mergeLayerDown, mergeVisibleLayers, cropRasterDocument, migrateRasterDocumentState, swapMaskRegion, layerDocumentPixels, liftSelection, setLayerFramePixels, setLayerPixels, stampFloatingInFrame, transformLayerInFrame, translateLayerOrigin } from "./index";
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

/** A fully opaque 100×100 layer on a 100×100 canvas. */
function opaqueLayer() {
  const document = createRasterDocument(100, 100);
  const layer = document.layers[0]!;
  setLayerPixels(layer, new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100);
  return layer;
}

describe("transforms committed over a frame, not the canvas", () => {
  it("a scale that carries the layer past the right edge keeps that part", () => {
    const layer = opaqueLayer();
    const { pixels, frame } = transformLayerInFrame(layer, 100, 100, { x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 0, width: 120, height: 100 }, 0);
    setLayerFramePixels(layer, pixels, frame);
    expect(layer.bounds).toEqual({ x: 50, y: 0, width: 120, height: 100 });
    expect(alphaAt(layer, 160, 50)).toBe(255);
  });

  it("a rotation keeps the corners that leave the canvas", () => {
    const layer = opaqueLayer();
    const { pixels, frame } = transformLayerInFrame(layer, 100, 100, { x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }, 45);
    setLayerFramePixels(layer, pixels, frame);
    expect(layer.bounds.x).toBeLessThan(-15);
    expect(layer.bounds.x + layer.bounds.width).toBeGreaterThan(115);
    expect(alphaAt(layer, 50, -15)).toBe(255);
  });

  it("transforming a layer that already reaches past the canvas includes that part", () => {
    const layer = opaqueLayer();
    translateLayerOrigin(layer, -30, 0);
    const { pixels, frame } = transformLayerInFrame(layer, 100, 100, layer.bounds, { ...layer.bounds, x: layer.bounds.x + 10 }, 0);
    setLayerFramePixels(layer, pixels, frame);
    expect(layer.bounds).toEqual({ x: -20, y: 0, width: 100, height: 100 });
  });

  it("moving selected pixels over the edge keeps what went past it and what was already outside", () => {
    const layer = opaqueLayer();
    translateLayerOrigin(layer, 0, -10); // ten rows already above the canvas
    const mask = new Uint8ClampedArray(100 * 100);
    for (let y = 40; y < 60; y += 1) for (let x = 0; x < 20; x += 1) mask[y * 100 + x] = 255;
    const selection = { mask, bounds: { x: 0, y: 40, width: 20, height: 20 } };
    const float = liftSelection(layerDocumentPixels(layer, 100, 100), 100, 100, selection);
    const { pixels, frame } = stampFloatingInFrame(layer, 100, 100, float, -15, 0);
    setLayerFramePixels(layer, pixels, frame);
    expect(alphaAt(layer, -15, 45)).toBe(255); // carried past the left edge
    expect(alphaAt(layer, 10, 45)).toBe(0); // the hole it left behind
    expect(alphaAt(layer, 50, -5)).toBe(255); // was above the canvas before, untouched
    expect(layer.bounds.x).toBe(-15);
    expect(layer.bounds.y).toBe(-10);
  });
});

/** A 100×100 opaque layer whose mask reveals the left half and hides the right. */
function maskedDocument() {
  const document = createRasterDocument(100, 100);
  const layer = document.layers[0]!;
  setLayerPixels(layer, new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100);
  const mask = createRasterLayerMask(100, 100, false);
  const values = mask.tiles.toPixels();
  for (let y = 0; y < 100; y += 1) for (let x = 0; x < 50; x += 1) values[y * 100 + x] = 255;
  layer.mask = { ...mask, tiles: createRasterLayerMask(100, 100, false).tiles };
  swapMaskRegion(layer.mask, { x: 0, y: 0, width: 100, height: 100 }, values, 100, 100);
  return document;
}

const maskAt = (state: ReturnType<typeof createRasterDocument>, x: number, y: number) => state.layers[0]!.mask!.tiles.readPixel(x, y)[0];

describe("crop keeping pixels keeps the layer mask too", () => {
  it("growing the canvas back brings the mask back, not a black one", () => {
    const cropped = cropRasterDocument(maskedDocument(), { x: 25, y: 25, width: 50, height: 50 }, false);
    expect(cropped.layers[0]!.mask!.tiles.width).toBe(50);
    const restored = cropRasterDocument(cropped, { x: -25, y: -25, width: 100, height: 100 }, false, true);
    expect(restored.layers[0]!.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(maskAt(restored, 5, 5)).toBe(255);
    expect(maskAt(restored, 95, 95)).toBe(0);
    expect(maskAt(restored, 10, 90)).toBe(255);
  });

  it("an edit made inside the cropped canvas survives the canvas growing back", () => {
    const cropped = cropRasterDocument(maskedDocument(), { x: 25, y: 25, width: 50, height: 50 }, false);
    const mask = cropped.layers[0]!.mask!;
    swapMaskRegion(mask, { x: 40, y: 0, width: 10, height: 10 }, new Uint8ClampedArray(100).fill(255), 50, 50);
    const restored = cropRasterDocument(cropped, { x: -25, y: -25, width: 100, height: 100 }, false, true);
    expect(maskAt(restored, 70, 30)).toBe(255); // edited while cropped, was black originally
    expect(maskAt(restored, 90, 90)).toBe(0); // parked, untouched
  });

  it("Delete Cropped Pixels discards what was cut, as before", () => {
    const cropped = cropRasterDocument(maskedDocument(), { x: 25, y: 25, width: 50, height: 50 }, true);
    expect(cropped.layers[0]!.mask!.outside).toBeUndefined();
    const grown = cropRasterDocument(cropped, { x: -25, y: -25, width: 100, height: 100 }, false, true);
    expect(maskAt(grown, 5, 5)).toBe(0);
  });

  it("the parked mask is rebuilt as a tile store when a session is restored", () => {
    const cropped = cropRasterDocument(maskedDocument(), { x: 25, y: 25, width: 50, height: 50 }, false);
    const layer = cropped.layers[0]!, outside = layer.mask!.outside!;
    // What document-snapshot-store.ts hands back: TileStore.toJSON() shapes, typed arrays intact.
    const saved = { ...cropped, layers: [{ ...layer, tiles: layer.tiles.toJSON(), mask: { ...layer.mask!, tiles: layer.mask!.tiles.toJSON(), outside: { bounds: outside.bounds, tiles: outside.tiles.toJSON() } } }] };
    const restored = migrateRasterDocumentState(saved as unknown as typeof cropped);
    const regrown = cropRasterDocument(restored, { x: -25, y: -25, width: 100, height: 100 }, false, true);
    expect(maskAt(regrown, 5, 5)).toBe(255);
    expect(maskAt(regrown, 95, 95)).toBe(0);
  });
});

/** Two layers: a red 100×100 one dragged 30 px past the left edge, and a half-transparent blue
 * square on top reaching 20 px past the bottom. */
function overhangingPair() {
  const document = createRasterDocument(100, 100);
  const lower = document.layers[0]!;
  const red = new Uint8ClampedArray(100 * 100 * 4);
  for (let index = 0; index < red.length; index += 4) { red[index] = 255; red[index + 3] = 255; }
  setLayerPixels(lower, red, 100, 100);
  translateLayerOrigin(lower, -30, 0);
  const upper = createRasterLayer(100, 100, "Upper");
  const blue = new Uint8ClampedArray(100 * 100 * 4);
  for (let y = 60; y < 100; y += 1) for (let x = 40; x < 80; x += 1) { const index = (y * 100 + x) * 4; blue[index + 2] = 255; blue[index + 3] = 128; }
  setLayerPixels(upper, blue, 100, 100);
  translateLayerOrigin(upper, 0, 20);
  document.layers.push({ ...upper, parentId: null });
  document.activeLayerId = upper.id;
  return document;
}

describe("merging keeps what the layers hold past the canvas", () => {
  it("Merge Down keeps both layers' overhang and matches the canvas composite inside", () => {
    const document = overhangingPair();
    const onCanvas = compositeRasterRegion(document, { x: 0, y: 0, width: 100, height: 100 });
    const merged = mergeLayerDown(document, document.activeLayerId)!;
    expect(merged.bounds).toEqual({ x: -30, y: 0, width: 110, height: 120 });
    expect(alphaAt(merged, -30, 50)).toBe(255);
    expect(alphaAt(merged, 50, 110)).toBe(128);
    expect(layerDocumentPixels(merged, 100, 100)).toEqual(onCanvas);
  });

  it("Merge Visible does the same", () => {
    const document = overhangingPair();
    const merged = mergeVisibleLayers(document)!;
    expect(merged.bounds).toEqual({ x: -30, y: 0, width: 110, height: 120 });
  });

  it("a canvas-sized mask reveals the overhang rather than hiding it", () => {
    const document = overhangingPair();
    document.layers[0]!.mask = createRasterLayerMask(100, 100);
    const merged = mergeLayerDown(document, document.activeLayerId)!;
    expect(alphaAt(merged, -20, 10)).toBe(255);
  });
});
