import { describe, expect, it } from "vitest";
import { adjustRgb, applyAdjustment, buildCurveLut } from "./adjustments";

describe("adjustments", () => {
  it("keeps an identity curve exact", () => {
    const lut = buildCurveLut([{ x: 0, y: 0 }, { x: 255, y: 255 }]);
    expect(Array.from(lut)).toEqual(Array.from({ length: 256 }, (_, index) => index));
  });

  it("uses Patchy's posterize and threshold formulas", () => {
    expect(adjustRgb(100, 140, 220, { kind: "posterize", levels: 2 })).toEqual([0, 255, 255]);
    expect(adjustRgb(100, 140, 220, { kind: "threshold", threshold: 128 })).toEqual([255, 255, 255]);
  });

  it("preserves alpha and interpolates adjustment opacity", () => {
    const pixels = new Uint8ClampedArray([20, 40, 60, 128, 10, 20, 30, 0]);
    applyAdjustment(pixels, { kind: "invert" }, .5);
    expect(Array.from(pixels)).toEqual([128, 128, 128, 128, 10, 20, 30, 0]);
  });
});
import { applyRasterFilter, blurDab, combineSelections, compositeRasterDocument, createContiguousColorSelection, createEllipseSelection, createPolygonSelection, createRasterDocument, createRasterLayer, createRectangleSelection, cropRasterDocument, drawDab, drawQuadraticStrokeSegment, floodFill, invertPixelSelection, parseHexColor, patchFromSelection, renderLayerEffects, restrictSelectionToAlpha, rotateLayerPixels, rotateSelection, sampleAverage, scaleLayerPixels, scaleSelection, selectAllPixels, selectOpaquePixels, selectionOutlinePath, smudgeStrokeSegment, translateLayerPixels, translateSelection } from "./index";

describe("raster document", () => {
  it("creates a transparent active layer with exact dimensions", () => {
    const document = createRasterDocument(4, 3);
    expect(document.layers[0]?.pixels).toHaveLength(48);
    expect(document.activeLayerId).toBe(document.layers[0]?.id);
  });

  it("preserves creation metadata and can initialize an opaque background", () => {
    const document = createRasterDocument(2, 1, { resolution: 300, backgroundColor: "#112233", pixelAspectRatio: 1.5 });
    expect(document.resolution).toBe(300);
    expect(document.pixelAspectRatio).toBe(1.5);
    expect([...document.layers[0]!.pixels.slice(0, 4)]).toEqual([17, 34, 51, 255]);
  });
});

describe("paint", () => {
  it("draws and erases through the same mask pipeline", () => {
    const pixels = new Uint8ClampedArray(5 * 5 * 4);
    drawDab(pixels, 5, 5, { x: 2.5, y: 2.5 }, 3, parseHexColor("#ff0000"), 1);
    expect(pixels[(2 * 5 + 2) * 4]).toBe(255);
    expect(pixels[(2 * 5 + 2) * 4 + 3]).toBe(255);
    drawDab(pixels, 5, 5, { x: 2.5, y: 2.5 }, 3, parseHexColor("#000000"), 1, true);
    expect(pixels[(2 * 5 + 2) * 4 + 3]).toBe(0);
  });

  it("clips brush coverage to the active alpha selection", () => {
    const pixels = new Uint8ClampedArray(3 * 3 * 4);
    const selection = new Uint8ClampedArray(3 * 3); selection[4] = 255;
    drawDab(pixels, 3, 3, { x: 1.5, y: 1.5 }, 5, parseHexColor("#ff0000"), 1, false, 1, selection);
    expect(pixels[4 * 4]).toBe(255);
    expect(pixels[0]).toBe(0);
  });

  it("resamples a curved pointer path instead of joining sparse points as corners", () => {
    const pixels = new Uint8ClampedArray(7 * 5 * 4);
    drawQuadraticStrokeSegment(pixels, 7, 5, { x: 1, y: 3 }, { x: 3, y: 0 }, { x: 5, y: 3 }, 1, parseHexColor("#ffffff"), 1, false);
    expect(pixels[(1 * 7 + 3) * 4 + 3]).toBeGreaterThan(0);
  });

  it("renders angled non-round brush tips", () => {
    const horizontal = new Uint8ClampedArray(11 * 11 * 4);
    const vertical = new Uint8ClampedArray(11 * 11 * 4);
    drawDab(horizontal, 11, 11, { x: 5.5, y: 5.5 }, 9, parseHexColor("#ffffff"), 1, false, 1, undefined, .25, 0, false);
    drawDab(vertical, 11, 11, { x: 5.5, y: 5.5 }, 9, parseHexColor("#ffffff"), 1, false, 1, undefined, .25, 90, false);
    expect(horizontal[(5 * 11 + 1) * 4 + 3]).toBeGreaterThan(0);
    expect(horizontal[(1 * 11 + 5) * 4 + 3]).toBe(0);
    expect(vertical[(1 * 11 + 5) * 4 + 3]).toBeGreaterThan(0);
  });
});

describe("layer rendering", () => {
  it("keeps Fill separate from layer Opacity while compositing", () => {
    const document = createRasterDocument(1, 1, { backgroundColor: "#0000ff" });
    const top = createRasterLayer(1, 1); top.pixels.set([255, 0, 0, 255]); top.fillOpacity = .5; document.layers.push(top);
    const rendered = compositeRasterDocument(document);
    expect([...rendered]).toEqual([128, 0, 128, 255]);
  });

  it("renders layer effects without mutating source pixels", () => {
    const layer = createRasterLayer(3, 1); layer.pixels.set([255, 255, 255, 255], 0);
    layer.effects.dropShadow = { enabled: true, color: "#000000", opacity: 1, offsetX: 1, offsetY: 0 };
    const rendered = renderLayerEffects(layer, 3, 1);
    expect(rendered[7]).toBe(255);
    expect(layer.pixels[7]).toBe(0);
  });
});

describe("flood fill", () => {
  it("fills only the connected region within tolerance", () => {
    const pixels = new Uint8ClampedArray([
      0,0,0,255, 0,0,0,255, 255,255,255,255,
      0,0,0,255, 255,255,255,255, 255,255,255,255,
    ]);
    expect(floodFill(pixels, 3, 2, 0, 0, { r: 20, g: 30, b: 40, a: 255 })).toBe(3);
    expect([...pixels.slice(0, 4)]).toEqual([20, 30, 40, 255]);
    expect([...pixels.slice(8, 12)]).toEqual([255, 255, 255, 255]);
  });

  it("does not cross pixels excluded by the selection mask", () => {
    const pixels = new Uint8ClampedArray(3 * 4);
    const selection = new Uint8ClampedArray([255, 0, 0]);
    expect(floodFill(pixels, 3, 1, 0, 0, { r: 50, g: 60, b: 70, a: 255 }, 0, selection)).toBe(1);
    expect([...pixels.slice(0, 4)]).toEqual([50, 60, 70, 255]);
    expect([...pixels.slice(4, 8)]).toEqual([0, 0, 0, 0]);
  });
});

describe("sampling", () => {
  it("averages a clipped sample window", () => {
    const pixels = new Uint8ClampedArray([0,0,0,255, 100,100,100,255, 200,200,200,255, 100,100,100,255]);
    expect(sampleAverage(pixels, 2, 2, 0, 0, 3)).toEqual({ r: 100, g: 100, b: 100, a: 255 });
  });
});

describe("pixel selection", () => {
  it("creates an alpha-mask rectangle and combines selection modes", () => {
    const first = createRectangleSelection(6, 4, 1, 1, 4, 3);
    const second = createRectangleSelection(6, 4, 3, 0, 5, 2);
    expect(first.bounds).toEqual({ x: 1, y: 1, width: 3, height: 2 });
    expect(combineSelections(first, second, 6, 4, "add")?.bounds).toEqual({ x: 1, y: 0, width: 4, height: 3 });
    expect(combineSelections(first, second, 6, 4, "intersect")?.bounds).toEqual({ x: 3, y: 1, width: 1, height: 1 });
    expect(combineSelections(first, second, 6, 4, "subtract")?.mask[1 * 6 + 3]).toBe(0);
  });

  it("keeps soft alpha values when feathering", () => {
    const selection = createRectangleSelection(7, 7, 2, 2, 5, 5, 1);
    expect(selection.mask[1 * 7 + 2]).toBeGreaterThan(0);
    expect(selection.mask[3 * 7 + 3]).toBe(255);
  });

  it("selects all and inverts without losing alpha semantics", () => {
    const all = selectAllPixels(3, 2);
    expect([...all.mask]).toEqual([255, 255, 255, 255, 255, 255]);
    expect(invertPixelSelection(all, 3, 2)).toBeNull();
    expect(invertPixelSelection(null, 3, 2)?.bounds).toEqual({ x: 0, y: 0, width: 3, height: 2 });
  });

  it("creates ellipse, polygon and contiguous color selections", () => {
    const ellipse = createEllipseSelection(7, 7, 1, 1, 6, 6);
    expect(ellipse.mask[3 * 7 + 3]).toBe(255);
    expect(ellipse.mask[1 * 7 + 1]).toBe(0);
    const polygon = createPolygonSelection(6, 6, [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 3, y: 5 }]);
    expect(polygon.mask[2 * 6 + 3]).toBe(255);
    expect(polygon.mask[5 * 6]).toBe(0);
    const pixels = new Uint8ClampedArray([10,10,10,255, 10,10,10,255, 200,200,200,255, 10,10,10,255]);
    const contiguous = createContiguousColorSelection(pixels, 4, 1, 0, 0, 0);
    expect([...contiguous.mask]).toEqual([255, 255, 0, 0]);
    expect(selectionOutlinePath(ellipse.mask, 7, 7)).not.toBe(`M1 1h5`);
  });

  it("never keeps transparent pixels in a content selection", () => {
    const pixels = new Uint8ClampedArray(3 * 4); pixels.set([20, 30, 40, 255], 4);
    const geometry = createRectangleSelection(3, 1, 0, 0, 3, 1);
    expect(restrictSelectionToAlpha(geometry, pixels, 3, 1)?.bounds).toEqual({ x: 1, y: 0, width: 1, height: 1 });
    expect(selectOpaquePixels(new Uint8ClampedArray(3 * 4), 3, 1)).toBeNull();
  });
});

describe("raster transform", () => {
  it("moves only selected pixels and moves the selection mask with them", () => {
    const pixels = new Uint8ClampedArray(4 * 4); pixels.set([255, 0, 0, 255], 0);
    const selection = createRectangleSelection(4, 1, 0, 0, 1, 1);
    const moved = translateLayerPixels(pixels, 4, 1, 2, 0, selection);
    expect([...moved.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...moved.slice(8, 12)]).toEqual([255, 0, 0, 255]);
    expect(translateSelection(selection, 4, 1, 2, 0)?.bounds).toEqual({ x: 2, y: 0, width: 1, height: 1 });
  });

  it("does not erase destination pixels under transparent selected content", () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255]);
    const selection = createRectangleSelection(3, 1, 0, 0, 2, 1);
    const moved = translateLayerPixels(pixels, 3, 1, 1, 0, selection);
    expect([...moved.slice(8, 12)]).toEqual([0, 0, 255, 255]);
  });

  it("scales selected pixels and its selection without committing intermediate destinations", () => {
    const pixels = new Uint8ClampedArray(4 * 4); pixels.set([255, 0, 0, 255], 0);
    const selection = createRectangleSelection(4, 1, 0, 0, 1, 1);
    const scaled = scaleLayerPixels(pixels, 4, 1, selection.bounds, { x: 1, y: 0, width: 2, height: 1 }, selection);
    expect([...scaled.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(scaled[7]).toBe(255); expect(scaled[11]).toBe(255);
    expect(scaleSelection(selection, 4, 1, selection.bounds, { x: 1, y: 0, width: 2, height: 1 })?.bounds).toEqual({ x: 1, y: 0, width: 2, height: 1 });
  });

  it("rotates selected pixels and its mask around the transform center", () => {
    const pixels = new Uint8ClampedArray(3 * 3 * 4); pixels.set([255, 0, 0, 255], (1 * 3 + 2) * 4);
    const selection = createRectangleSelection(3, 3, 2, 1, 3, 2), bounds = { x: 0, y: 0, width: 3, height: 3 };
    const rotated = rotateLayerPixels(pixels, 3, 3, bounds, 90, selection);
    expect(rotated[(2 * 3 + 1) * 4 + 3]).toBe(255);
    expect(rotateSelection(selection, 3, 3, bounds, 90)?.mask[2 * 3 + 1]).toBe(255);
  });

  it("crops every layer and selection to the requested document rectangle", () => {
    const document = createRasterDocument(4, 3, { backgroundColor: "#112233" });
    document.selection = createRectangleSelection(4, 3, 1, 1, 4, 3);
    const cropped = cropRasterDocument(document, { x: 1, y: 1, width: 2, height: 2 });
    expect(cropped).toMatchObject({ width: 2, height: 2 });
    expect(cropped.layers[0]?.pixels).toHaveLength(16);
    expect(cropped.selection?.bounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });
});

describe("raster retouch tools", () => {
  it("blurs only inside the brush footprint", () => {
    const source = new Uint8ClampedArray(5 * 4);
    for (let x = 0; x < 5; x += 1) source.set(x === 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], x * 4);
    const result = source.slice();
    blurDab(result, source, 5, 1, { x: 2.5, y: .5 }, 3, 1);
    expect(result[2 * 4]).toBeLessThan(255);
    expect(result[2 * 4]).toBeGreaterThan(0);
    expect(result[0]).toBe(0);
  });

  it("smudges pixels along a stroke", () => {
    const source = new Uint8ClampedArray(5 * 4); source.set([255, 0, 0, 255], 4);
    const result = source.slice();
    smudgeStrokeSegment(result, source, 5, 1, { x: 1.5, y: .5 }, { x: 3.5, y: .5 }, 2, 1);
    expect(result[3 * 4]).toBeGreaterThan(0);
  });

  it("uses a document mask at its real selection bounds for Patch", () => {
    const pixels = new Uint8ClampedArray(4 * 4); pixels.set([255, 0, 0, 255], 0);
    const mask = new Uint8ClampedArray([0, 0, 255, 0]);
    patchFromSelection(pixels, 4, 1, mask, { x: 2, y: 0, width: 1, height: 1 }, -2, 0, 1);
    expect(pixels[2 * 4 + 3]).toBe(255);
    expect(pixels[3 * 4 + 3]).toBe(0);
  });
});

describe("raster filters", () => {
  it("preserves dimensions and alpha while spreading a box blur", () => {
    const source = new Uint8ClampedArray(5 * 4);
    for (let x = 0; x < 5; x += 1) source.set(x === 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], x * 4);
    const result = applyRasterFilter(source, 5, 1, "box_blur", { radius: 1 });
    expect(result).toHaveLength(source.length);
    expect(result[2 * 4]).toBeGreaterThan(0);
    expect(result[1 * 4]).toBeGreaterThan(0);
    expect(result[0]).toBe(0);
    expect(result[3]).toBe(255);
  });
});
