import { describe, expect, it } from "vitest";
import { createRasterLayer } from "./document";
import { duplicateLayer, layerAccepts, layerLockReason } from "./layer-ops";
import { compositeRasterDocument } from "./render";
import { convertLayerToEmbeddedSmartObject, isEditableEmbeddedSmartObject, makeIndependentEmbeddedSmartObjectCopy, replaceSmartObjectSourcePixels, smartObjectSourceMode, transformSmartObject, translateSmartObject } from "./smart-object";
import type { RasterDocumentState } from "./types";

describe("embedded Smart Objects", () => {
  it("converts a pixel layer into a source-backed embedded object", () => {
    const layer = createRasterLayer(2, 2, "Mark");
    layer.pixels[3] = 255;

    expect(convertLayerToEmbeddedSmartObject(layer, "asset-mark")).toBe(true);
    expect(layer.kind).toBe("smart");
    expect(layer.pixelAssetId).toBe("asset-mark");
    expect(layer.smartSource).toEqual({ assetId: "asset-mark", pinnedRev: null, sourceKind: "raster", mode: "embedded" });
    expect(layer.pixels[3]).toBe(255);
    expect(isEditableEmbeddedSmartObject(layer)).toBe(true);
    expect(smartObjectSourceMode(layer.smartSource)).toBe("embedded");
  });

  it("keeps a duplicate on the same source and refuses direct paint", () => {
    const layer = createRasterLayer(2, 2, "Mark");
    convertLayerToEmbeddedSmartObject(layer, "asset-mark");
    const state: RasterDocumentState = { kind: "raster", schemaVersion: 2, width: 2, height: 2, colorSpace: "srgb", resolution: 72, resolutionUnit: "ppi", bitDepth: 8, pixelAspectRatio: 1, backgroundColor: null, layers: [layer], activeLayerId: layer.id, selection: null, guides: [] };

    const copy = duplicateLayer(state, layer.id)!;
    expect(copy.kind).toBe("smart");
    expect(copy.pixelAssetId).toBe("asset-mark");
    expect(copy.smartSource?.assetId).toBe("asset-mark");
    expect(layerAccepts(copy, "paint")).toBe(false);
    expect(layerLockReason(copy, "paint")).toMatch(/Smart Object/);
    expect(layerAccepts(copy, "move")).toBe(true);
  });

  it("can detach only a duplicated instance onto a fresh embedded source", () => {
    const layer = createRasterLayer(2, 2, "Mark");
    convertLayerToEmbeddedSmartObject(layer, "asset-original");
    const state: RasterDocumentState = { kind: "raster", schemaVersion: 2, width: 2, height: 2, colorSpace: "srgb", resolution: 72, resolutionUnit: "ppi", bitDepth: 8, pixelAspectRatio: 1, backgroundColor: null, layers: [layer], activeLayerId: layer.id, selection: null, guides: [] };
    const copy = duplicateLayer(state, layer.id)!;

    expect(makeIndependentEmbeddedSmartObjectCopy(copy, "asset-copy")).toBe(true);
    expect(layer.smartSource?.assetId).toBe("asset-original");
    expect(copy.smartSource?.assetId).toBe("asset-copy");
    expect(copy.pixelAssetId).toBe("asset-copy");
  });

  it("changes placement rather than resampling source pixels on transforms", () => {
    const layer = createRasterLayer(2, 2, "Mark");
    for (let pixel = 0; pixel < layer.pixels.length; pixel += 4) { layer.pixels[pixel] = 240; layer.pixels[pixel + 3] = 255; }
    const source = layer.pixels.slice();
    convertLayerToEmbeddedSmartObject(layer, "asset-mark");

    expect(transformSmartObject(layer, { x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 1, width: 4, height: 4 }, 0)).toBe(true);
    expect(layer.pixels).toEqual(source);
    expect(layer.bounds).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(translateSmartObject(layer, 1, 0)).toBe(true);
    expect(layer.pixels).toEqual(source);

    const state: RasterDocumentState = { kind: "raster", schemaVersion: 2, width: 8, height: 8, colorSpace: "srgb", resolution: 72, resolutionUnit: "ppi", bitDepth: 8, pixelAspectRatio: 1, backgroundColor: null, layers: [layer], activeLayerId: layer.id, selection: null, guides: [] };
    const composited = compositeRasterDocument(state);
    expect(composited[(2 * 8 + 2) * 4 + 3]).toBe(255);
    expect(composited[(0 * 8 + 0) * 4 + 3]).toBe(0);
  });

  it("keeps placed geometry when edited Smart Object contents have another size", () => {
    const layer = createRasterLayer(2, 2, "Mark");
    convertLayerToEmbeddedSmartObject(layer, "asset-mark");
    transformSmartObject(layer, { x: 0, y: 0, width: 2, height: 2 }, { x: 5, y: 4, width: 8, height: 6 }, 0);
    expect(replaceSmartObjectSourcePixels(layer, new Uint8ClampedArray(4 * 3 * 4), 4, 3)).toBe(true);
    expect(layer.bounds).toEqual({ x: 5, y: 4, width: 8, height: 6 });
  });
});
