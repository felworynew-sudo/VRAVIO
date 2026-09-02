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
import { appendLayer, appendRasterGroup, applyRasterFilter, blurDab, combineSelections, DirtyRegion, RasterTileCache, TileCompositor, extractTile, findSmartCrop, planTiles, saliencyMap, builtInLuts, formatCubeLut, generateLut, identityLut, parseCubeLut, sampleColorLookup, expandRectForFilter, filterPassCount, filterSpecById, filterSpecs, hasGpuFilter, clampRegionToDocument, compositeRasterDocument, compositeRasterRegion, compositeRasterThumbnail, createAdjustmentLayer, createContiguousColorSelection, createEllipseSelection, createPolygonSelection, createRasterDocument, createRasterLayer, createRectangleSelection, cropRasterDocument, drawDab, drawShape, drawQuadraticStrokeSegment, floodFill, invertPixelSelection, isRasterDocumentState, parseHexColor, patchFromSelection, rasterLayerDescendantIds, rasterLayerRows, renderLayerEffects, restrictSelectionToAlpha, rotateLayerPixels, rotateSelection, sampleAverage, scaleLayerPixels, scaleSelection, selectAllPixels, selectOpaquePixels, selectionOutlinePath, smudgeStrokeSegment, translateLayerPixels, translateSelection } from "./index";
import { createLiquifyState, liquifyWarp, renderLiquify } from "./liquify";

describe("liquify", () => {
  it("moves visible pixels with the forward-warp gesture like Patchy's inverse field", () => {
    const pixels = new Uint8ClampedArray(5 * 4); pixels.set([255, 0, 0, 255], 4);
    const state = createLiquifyState(5, 1);
    liquifyWarp(state, 2, 0, 1, 0, 3, 1, 1);
    const rendered = renderLiquify(pixels, 5, 1, state);
    expect(rendered[2 * 4]).toBeGreaterThan(0);
  });

  it("normalizes a proxy displacement field to the full-resolution output", () => {
    const pixels = new Uint8ClampedArray(9 * 4); pixels.set([255, 255, 255, 255], 4);
    const proxy = createLiquifyState(3, 1); proxy.dx[1] = -0.5;
    const rendered = renderLiquify(pixels, 9, 1, proxy);
    expect(rendered[3 * 4]).toBeGreaterThan(0);
  });
});

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

  it("migrates restored v1 layers into the normalized tree", () => {
    const document = createRasterDocument(2, 2);
    const legacy = { ...document, schemaVersion: 1, layers: document.layers.map(({ parentId: _parentId, orderKey: _orderKey, clipping: _clipping, ...layer }) => layer) };
    expect(isRasterDocumentState(legacy)).toBe(true);
    expect(legacy.schemaVersion).toBe(2);
    expect((legacy.layers[0] as typeof document.layers[number]).parentId).toBeNull();
    expect((legacy.layers[0] as typeof document.layers[number]).orderKey).toBe("00000000");
  });

  it("builds collapsible group rows and reports descendants", () => {
    const document = createRasterDocument(2, 2);
    const group = appendRasterGroup(document);
    const child = appendLayer(document, createRasterLayer(2, 2, "Child"), group.id);
    expect(rasterLayerRows(document.layers).find((row) => row.layer.id === child.id)?.depth).toBe(1);
    group.expanded = false;
    expect(rasterLayerRows(document.layers).some((row) => row.layer.id === child.id)).toBe(false);
    expect(rasterLayerDescendantIds(document.layers, group.id)).toEqual([child.id]);
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

  it("applies layer masks and ancestor visibility during compositing", () => {
    const document = createRasterDocument(2, 1);
    document.layers[0]!.visible = false;
    const group = appendRasterGroup(document);
    group.opacity = .5;
    const child = createRasterLayer(2, 1); child.pixels.set([255, 0, 0, 255, 255, 0, 0, 255]);
    child.mask = { pixels: new Uint8ClampedArray([255, 0]), assetId: null, enabled: true, inverted: false, linked: true, density: 1, feather: 0 };
    appendLayer(document, child, group.id);
    expect([...compositeRasterDocument(document)]).toEqual([255, 0, 0, 128, 0, 0, 0, 0]);
    group.visible = false;
    expect([...compositeRasterDocument(document)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("creates a white mask for adjustment layers and masks their correction", () => {
    const document = createRasterDocument(2, 1, { backgroundColor: "#102030" });
    const adjustment = createAdjustmentLayer(2, 1, "invert");
    adjustment.mask!.pixels[1] = 0;
    appendLayer(document, adjustment);
    expect([...compositeRasterDocument(document)]).toEqual([239, 223, 207, 255, 16, 32, 48, 255]);
  });

  it("clips a layer to the alpha of the preceding base layer", () => {
    const document = createRasterDocument(2, 1);
    const base = document.layers[0]!; base.pixels.set([0, 0, 255, 255, 0, 0, 0, 0]);
    const clipped = createRasterLayer(2, 1); clipped.pixels.set([255, 0, 0, 255, 255, 0, 0, 255]); clipped.clipping = true;
    appendLayer(document, clipped);
    expect([...compositeRasterDocument(document)]).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
    base.visible = false;
    expect([...compositeRasterDocument(document)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("composites a sub-region identically to the matching slice of the full canvas", () => {
    const document = createRasterDocument(6, 4, { backgroundColor: "#204060" });
    const painted = createRasterLayer(6, 4);
    for (let index = 0; index < painted.pixels.length; index += 4) painted.pixels.set([index % 255, (index * 3) % 255, (index * 7) % 255, (index * 5) % 255], index);
    painted.blendMode = "overlay";
    painted.opacity = .7;
    appendLayer(document, painted);
    const clipped = createRasterLayer(6, 4);
    clipped.pixels.fill(190); clipped.clipping = true;
    appendLayer(document, clipped);
    const adjustment = createAdjustmentLayer(6, 4, "invert");
    adjustment.mask!.pixels.fill(120);
    appendLayer(document, adjustment);

    const full = compositeRasterDocument(document);
    for (const region of [{ x: 0, y: 0, width: 6, height: 4 }, { x: 2, y: 1, width: 3, height: 2 }, { x: 5, y: 3, width: 1, height: 1 }]) {
      const patch = compositeRasterRegion(document, region);
      const expected: number[] = [];
      for (let row = 0; row < region.height; row += 1) for (let column = 0; column < region.width; column += 1) {
        const index = ((region.y + row) * 6 + (region.x + column)) * 4;
        expected.push(full[index]!, full[index + 1]!, full[index + 2]!, full[index + 3]!);
      }
      expect([...patch]).toEqual(expected);
    }
  });

  it("tones a duotone toward the chosen inks and dithers e-ink to discrete levels", () => {
    const grey = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255, 128, 128, 128, 255, 128, 128, 128, 255]);
    const duotone = applyRasterFilter(grey, 2, 2, "duotone", { shadowHue: 210, highlightHue: 45, amount: 100 });
    expect(duotone[0]).not.toBe(duotone[2]);

    const dithered = applyRasterFilter(grey, 2, 2, "eink", { levels: 2, amount: 100 });
    for (let index = 0; index < dithered.length; index += 4) expect([0, 255]).toContain(dithered[index]);
    // A flat mid grey must break into both blacks and whites rather than collapsing to one.
    const distinct = new Set([...dithered].filter((_unused, index) => index % 4 === 0));
    expect(distinct.size).toBe(2);
  });

  it("shifts colour channels for the CRT glitch and leaves alpha alone", () => {
    const pixels = new Uint8ClampedArray(8 * 4 * 4);
    for (let index = 0; index < pixels.length; index += 4) pixels.set([255, 0, 0, 200], index);
    const glitched = applyRasterFilter(pixels, 8, 4, "glitch", { shift: 3, scanline: 50, amount: 100 });
    expect(glitched[3]).toBe(200);
    expect([...glitched].filter((_unused, index) => index % 4 === 0).some((red) => red !== 255)).toBe(true);
  });

  it("fills and strokes shapes with antialiased edges", () => {
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    drawShape(pixels, 32, 32, { kind: "ellipse", rect: { x: 6, y: 6, width: 20, height: 20 }, fill: parseHexColor("#ff0000") });
    const centre = (16 * 32 + 16) * 4, outside = (1 * 32 + 1) * 4, edge = (16 * 32 + 6) * 4;
    expect(pixels[centre]).toBe(255);
    expect(pixels[centre + 3]).toBe(255);
    expect(pixels[outside + 3]).toBe(0);
    expect(pixels[edge + 3]).toBeGreaterThan(0);
    expect(pixels[edge + 3]).toBeLessThan(255);
  });

  it("draws a stroke without a fill and leaves the interior empty", () => {
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    drawShape(pixels, 32, 32, { kind: "rectangle", rect: { x: 8, y: 8, width: 16, height: 16 }, fill: null, stroke: parseHexColor("#00ff00"), strokeWidth: 3 });
    expect(pixels[(16 * 32 + 16) * 4 + 3]).toBe(0);
    expect(pixels[(8 * 32 + 16) * 4 + 3]).toBeGreaterThan(0);
  });

  it("normalizes rectangles dragged right-to-left and respects the selection mask", () => {
    const dragged = new Uint8ClampedArray(16 * 16 * 4);
    drawShape(dragged, 16, 16, { kind: "rectangle", rect: { x: 12, y: 12, width: -8, height: -8 }, fill: parseHexColor("#ffffff") });
    expect(dragged[(8 * 16 + 8) * 4 + 3]).toBe(255);

    const masked = new Uint8ClampedArray(16 * 16 * 4);
    const selection = new Uint8ClampedArray(16 * 16);
    selection[8 * 16 + 8] = 255;
    drawShape(masked, 16, 16, { kind: "rectangle", rect: { x: 4, y: 4, width: 8, height: 8 }, fill: parseHexColor("#ffffff") }, selection);
    expect(masked[(8 * 16 + 8) * 4 + 3]).toBe(255);
    expect(masked[(6 * 16 + 6) * 4 + 3]).toBe(0);
  });

  it("builds a thumbnail by sampling instead of compositing at full size", () => {
    const document = createRasterDocument(64, 32, { backgroundColor: "#ff0000" });
    const thumbnail = compositeRasterThumbnail(document, 8);
    expect(thumbnail.width).toBe(8);
    expect(thumbnail.height).toBe(4);
    expect(thumbnail.pixels).toHaveLength(8 * 4 * 4);
    expect([...thumbnail.pixels.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it("samples the same colours at reduced resolution as at full resolution", () => {
    const document = createRasterDocument(8, 8);
    const layer = document.layers[0]!;
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) layer.pixels.set([x * 30, y * 30, 0, 255], (y * 8 + x) * 4);
    const full = compositeRasterDocument(document);
    const half = compositeRasterRegion(document, { x: 0, y: 0, width: 8, height: 8 }, { step: 2 });
    for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
      const reduced = (row * 4 + column) * 4, source = ((row * 2) * 8 + column * 2) * 4;
      expect([...half.slice(reduced, reduced + 4)]).toEqual([...full.slice(source, source + 4)]);
    }
  });

  it("clamps regions that fall outside the document", () => {
    const document = createRasterDocument(3, 2, { backgroundColor: "#ffffff" });
    expect(clampRegionToDocument(document, { x: -5, y: -5, width: 20, height: 20 })).toEqual({ x: 0, y: 0, width: 3, height: 2 });
    expect(compositeRasterRegion(document, { x: 8, y: 8, width: 4, height: 4 })).toHaveLength(0);
    expect(compositeRasterRegion(document, { x: 2, y: 1, width: 9, height: 9 })).toHaveLength(4);
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

describe("tile cache", () => {
  it("collapses the dirty region once it exceeds its rectangle budget", () => {
    const region = new DirtyRegion(3);
    expect(region.isEmpty).toBe(true);
    for (let index = 0; index < 3; index += 1) region.add({ x: index * 10, y: 0, width: 5, height: 5 });
    expect(region.consume()).toHaveLength(3);
    for (let index = 0; index < 4; index += 1) region.add({ x: index * 10, y: index, width: 5, height: 5 });
    expect(region.consume()).toEqual([{ x: 0, y: 0, width: 35, height: 8 }]);
  });

  it("reports a whole-document invalidation distinctly from rectangles", () => {
    const region = new DirtyRegion();
    region.add({ x: 0, y: 0, width: 4, height: 4 });
    region.addEverything();
    expect(region.coversEverything).toBe(true);
    expect(region.consume()).toBeNull();
    expect(region.isEmpty).toBe(true);
  });

  it("composites a tile once and reuses it until it is invalidated", () => {
    const document = createRasterDocument(128, 64, { backgroundColor: "#3366ff" });
    const cache = new RasterTileCache({ tileSize: 32 });
    const viewport = { x: 0, y: 0, width: 128, height: 64 };

    const first = cache.update(document, viewport);
    expect(first.visible).toHaveLength(8);
    expect(first.repainted).toHaveLength(8);
    expect([...first.visible[0]!.pixels.slice(0, 4)]).toEqual([51, 102, 255, 255]);

    expect(cache.update(document, viewport).repainted).toHaveLength(0);

    cache.invalidate({ x: 0, y: 0, width: 1, height: 1 });
    const third = cache.update(document, viewport);
    expect(third.repainted).toHaveLength(1);
    expect(third.repainted[0]!.rect).toEqual({ x: 0, y: 0, width: 32, height: 32 });
    expect(third.visible).toHaveLength(8);
  });

  it("only composites tiles inside the requested viewport", () => {
    const document = createRasterDocument(256, 256);
    const cache = new RasterTileCache({ tileSize: 64 });
    const corner = cache.update(document, { x: 0, y: 0, width: 64, height: 64 });
    expect(corner.repainted).toHaveLength(1);
    expect(cache.size).toBe(1);
  });

  it("clips edge tiles to the document instead of overrunning it", () => {
    const document = createRasterDocument(70, 40);
    const cache = new RasterTileCache({ tileSize: 32 });
    const { visible } = cache.update(document, { x: 0, y: 0, width: 70, height: 40 });
    const last = visible.at(-1)!;
    expect(last.rect).toEqual({ x: 64, y: 32, width: 6, height: 8 });
    expect(last.pixels).toHaveLength(6 * 8 * 4);
  });

  it("evicts tiles beyond the byte budget while protecting visible ones", () => {
    const document = createRasterDocument(256, 64);
    const cache = new RasterTileCache({ tileSize: 32, budgetBytes: 32 * 32 * 4 * 4 });
    // Everything on screen stays cached even past the budget: dropping a tile the very next
    // blit needs would trade memory for a guaranteed recomposite.
    cache.update(document, { x: 0, y: 0, width: 256, height: 64 });
    expect(cache.size).toBe(16);
    // Once the viewport narrows, the off-screen tiles become evictable and the budget applies.
    const narrow = cache.update(document, { x: 0, y: 0, width: 32, height: 32 });
    expect(narrow.visible).toHaveLength(1);
    expect(cache.bytes).toBeLessThanOrEqual(32 * 32 * 4 * 4);
  });
});

describe("filter specs", () => {
  it("declares a CPU implementation for every spec so no device is left without a path", () => {
    expect(filterSpecs.length).toBeGreaterThan(0);
    for (const spec of filterSpecs) expect(typeof spec.cpu).toBe("function");
  });

  it("produces the same pixels through the CPU path as the existing catalog", () => {
    const source = new Uint8ClampedArray([10, 120, 240, 255, 200, 30, 60, 255]);
    const target = new Uint8ClampedArray(source.length);
    const spec = filterSpecById.get("invert")!;
    spec.cpu(source, target, 2, 1, {});
    expect([...target]).toEqual([...applyRasterFilter(source, 2, 1, "invert", {})]);
  });

  it("grows a dirty rectangle by the kernel radius and clamps it to the document", () => {
    const blur = filterSpecById.get("gaussian_blur")!;
    expect(expandRectForFilter({ x: 40, y: 40, width: 20, height: 20 }, blur, { radius: 8 }, 200, 200))
      .toEqual({ x: 32, y: 32, width: 36, height: 36 });
    // A rectangle at the edge must not reach outside the document.
    expect(expandRectForFilter({ x: 0, y: 0, width: 10, height: 10 }, blur, { radius: 8 }, 12, 12))
      .toEqual({ x: 0, y: 0, width: 12, height: 12 });
  });

  it("leaves the rectangle untouched for filters that read only their own pixel", () => {
    const sepia = filterSpecById.get("sepia")!;
    const rect = { x: 5, y: 6, width: 7, height: 8 };
    expect(expandRectForFilter(rect, sepia, { amount: 100 }, 100, 100)).toEqual(rect);
  });

  it("reports separable filters as multi-pass and reads back per-pass uniforms", () => {
    const blur = filterSpecById.get("gaussian_blur")!;
    expect(filterPassCount(blur, { radius: 4 })).toBe(2);
    expect(blur.gpu!.uniforms({ radius: 4 }, 0).direction).toEqual([1, 0]);
    expect(blur.gpu!.uniforms({ radius: 4 }, 1).direction).toEqual([0, 1]);
    expect(filterPassCount(filterSpecById.get("sepia")!, { amount: 100 })).toBe(1);
  });

  it("only routes a filter to the GPU when the shader is expected to win", () => {
    // Pointwise shaders beat the CPU; the gathering blur shader loses to the CPU sliding
    // window, so it stays declared but opted out.
    expect(hasGpuFilter("sepia")).toBe(true);
    expect(hasGpuFilter("gaussian_blur")).toBe(false);
    expect(filterSpecById.get("gaussian_blur")!.gpu!.glsl).toBeTruthy();
    expect(hasGpuFilter("plastic_wrap")).toBe(false);
  });
});

describe("colour lookup tables", () => {
  const NEWLINE = String.fromCharCode(10);
  const header = ['TITLE "Test"', "LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  const identityEntries = [
    "0 0 0", "1 0 0", "0 1 0", "1 1 0",
    "0 0 1", "1 0 1", "0 1 1", "1 1 1",
  ];
  const cubeText = [...header, ...identityEntries].join(NEWLINE);

  it("parses a .cube file including its title and size", () => {
    const lut = parseCubeLut(cubeText);
    expect(lut.title).toBe("Test");
    expect(lut.size).toBe(2);
    expect(lut.data).toHaveLength(8 * 3);
  });

  it("rejects malformed and 1D tables instead of producing wrong colours", () => {
    expect(() => parseCubeLut(["LUT_3D_SIZE 2", "0 0 0"].join(NEWLINE))).toThrow(/Expected/);
    expect(() => parseCubeLut(["LUT_1D_SIZE 16", "0 0 0"].join(NEWLINE))).toThrow(/1D/);
    expect(() => parseCubeLut("0 0 0")).toThrow(/LUT_3D_SIZE/);
  });

  it("leaves colours untouched through an identity table", () => {
    const lut = parseCubeLut(cubeText);
    for (const colour of [[0, 0, 0], [255, 255, 255], [30, 140, 210]]) {
      const [r, g, b] = sampleColorLookup(lut, colour[0]!, colour[1]!, colour[2]!);
      expect(Math.round(r)).toBe(colour[0]);
      expect(Math.round(g)).toBe(colour[1]);
      expect(Math.round(b)).toBe(colour[2]);
    }
  });

  it("interpolates between lattice points rather than snapping to them", () => {
    // A two-entry cube that only darkens: a mid grey must land mid-way, not on an endpoint.
    const half = generateLut("Half", 2, (r, g, b) => [r * 0.5, g * 0.5, b * 0.5]);
    const [r] = sampleColorLookup(half, 128, 128, 128);
    expect(r).toBeGreaterThan(60);
    expect(r).toBeLessThan(68);
  });

  it("round-trips through the .cube writer", () => {
    const original = builtInLuts[0]!;
    const reparsed = parseCubeLut(formatCubeLut(original));
    expect(reparsed.size).toBe(original.size);
    expect(reparsed.title).toBe(original.title);
    for (let index = 0; index < original.data.length; index += 997) {
      expect(reparsed.data[index]).toBeCloseTo(original.data[index]!, 5);
    }
  });

  it("applies a lookup adjustment and honours its amount", () => {
    const document = createRasterDocument(1, 1, { backgroundColor: "#808080" });
    const warm = builtInLuts.find((lut) => lut.title.startsWith("Warm"))!;
    const layer = createAdjustmentLayer(1, 1, "colorLookup");
    layer.adjustment = { kind: "colorLookup", lut: warm, amount: 1 };
    appendLayer(document, layer);
    const graded = compositeRasterDocument(document);
    expect(graded[0]).toBeGreaterThan(graded[2]!);

    layer.adjustment = { kind: "colorLookup", lut: warm, amount: 0 };
    expect([...compositeRasterDocument(document).slice(0, 3)]).toEqual([128, 128, 128]);
  });

  it("ships built-in looks that are real cubes, not per-channel curves", () => {
    expect(builtInLuts.length).toBeGreaterThan(0);
    for (const lut of builtInLuts) expect(lut.data).toHaveLength(lut.size ** 3 * 3);
    expect(identityLut(4).data).toHaveLength(4 ** 3 * 3);
  });
});

describe("tiling", () => {
  const gradient = (width: number, height: number): Uint8ClampedArray => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      pixels[index] = (x * 3) % 256;
      pixels[index + 1] = (y * 5) % 256;
      pixels[index + 2] = (x * y) % 256;
      pixels[index + 3] = 255;
    }
    return pixels;
  };

  it("covers the whole image and overlaps neighbours", () => {
    const plans = planTiles(200, 120, { tileSize: 64, overlap: 16 });
    expect(plans.length).toBeGreaterThan(1);
    for (const plan of plans) {
      expect(plan.rect.x + plan.rect.width).toBeLessThanOrEqual(200);
      expect(plan.rect.y + plan.rect.height).toBeLessThanOrEqual(120);
    }
    // Every pixel belongs to at least one tile.
    const covered = new Uint8Array(200 * 120);
    for (const plan of plans) for (let y = 0; y < plan.rect.height; y += 1) for (let x = 0; x < plan.rect.width; x += 1) {
      covered[(plan.rect.y + y) * 200 + plan.rect.x + x] = 1;
    }
    expect(covered.every((value) => value === 1)).toBe(true);
  });

  it("returns a single tile when the image is smaller than the tile", () => {
    expect(planTiles(40, 30, { tileSize: 64, overlap: 16 })).toHaveLength(1);
  });

  it("reassembles untouched tiles back into the original image", () => {
    const width = 200, height = 120, overlap = 16;
    const source = gradient(width, height);
    const compositor = new TileCompositor(width, height);
    for (const plan of planTiles(width, height, { tileSize: 64, overlap })) {
      compositor.add(extractTile(source, width, height, plan.rect), plan, overlap);
    }
    const rebuilt = compositor.finish();
    let maxDifference = 0;
    for (let index = 0; index < source.length; index += 1) maxDifference = Math.max(maxDifference, Math.abs(rebuilt[index]! - source[index]!));
    // A pass-through round trip must be lossless apart from rounding.
    expect(maxDifference).toBeLessThanOrEqual(1);
  });

  it("cross-fades disagreeing tiles instead of leaving a hard seam", () => {
    const width = 96, height = 32, overlap = 16;
    const compositor = new TileCompositor(width, height);
    const plans = planTiles(width, height, { tileSize: 64, overlap });
    plans.forEach((plan, index) => {
      const tile = new Uint8ClampedArray(plan.rect.width * plan.rect.height * 4);
      const value = index === 0 ? 0 : 255;
      for (let i = 0; i < tile.length; i += 4) { tile[i] = value; tile[i + 1] = value; tile[i + 2] = value; tile[i + 3] = 255; }
      compositor.add(tile, plan, overlap);
    });
    const blended = compositor.finish();
    const row = 16;
    const values = Array.from({ length: width }, (_unused, x) => blended[(row * width + x) * 4]!);
    // Somewhere in the overlap the two tiles must meet at an intermediate value.
    expect(values.some((value) => value > 20 && value < 235)).toBe(true);
    expect(values[0]).toBe(0);
    expect(values[width - 1]).toBe(255);
  });
});

describe("smart crop", () => {
  const canvasWithSubject = (width: number, height: number, subject: { x: number; y: number; size: number }): Uint8ClampedArray => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < pixels.length; index += 4) { pixels[index] = 120; pixels[index + 1] = 120; pixels[index + 2] = 120; pixels[index + 3] = 255; }
    for (let y = subject.y; y < subject.y + subject.size; y += 1) for (let x = subject.x; x < subject.x + subject.size; x += 1) {
      const index = (y * width + x) * 4;
      // Saturated, high-contrast checks: exactly what the saliency map is looking for.
      const on = ((x >> 1) + (y >> 1)) % 2 === 0;
      pixels[index] = on ? 250 : 10;
      pixels[index + 1] = on ? 20 : 200;
      pixels[index + 2] = on ? 30 : 40;
    }
    return pixels;
  };

  it("scores textured saturated areas above flat ones", () => {
    const width = 60, height = 40;
    const pixels = canvasWithSubject(width, height, { x: 5, y: 5, size: 20 });
    const map = saliencyMap(pixels, width, height);
    const inside = map[12 * width + 12]!;
    const outside = map[35 * width + 50]!;
    expect(inside).toBeGreaterThan(outside);
  });

  it("moves the crop toward the interesting region", () => {
    const width = 200, height = 120;
    const left = findSmartCrop(canvasWithSubject(width, height, { x: 8, y: 30, size: 44 }), width, height, { aspect: 1 });
    const right = findSmartCrop(canvasWithSubject(width, height, { x: 148, y: 30, size: 44 }), width, height, { aspect: 1 });
    expect(left.rect.x).toBeLessThan(right.rect.x);
    expect(left.score).toBeGreaterThan(0);
  });

  it("respects the requested aspect ratio and stays inside the image", () => {
    const width = 200, height = 120;
    const pixels = canvasWithSubject(width, height, { x: 80, y: 40, size: 40 });
    for (const aspect of [1, 16 / 9, 0.75]) {
      const { rect } = findSmartCrop(pixels, width, height, { aspect });
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height);
      expect(rect.width / rect.height).toBeCloseTo(aspect, 0);
    }
  });
});
