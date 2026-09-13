import { describe, expect, it } from "vitest";
import { createRasterLayer } from "./document";
import { duplicateLayer, layerAccepts, layerLockReason } from "./layer-ops";
import { convertLayerToEmbeddedSmartObject, isEditableEmbeddedSmartObject, makeIndependentEmbeddedSmartObjectCopy, smartObjectSourceMode } from "./smart-object";
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
});
