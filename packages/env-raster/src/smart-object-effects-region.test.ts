import { describe, expect, it } from "vitest";
import { compositeRasterDocument, compositeRasterRegion } from "./render";
import { createRasterDocument, createRasterLayer } from "./document";
import { appendLayer } from "./layer-tree";
import { convertLayerToEmbeddedSmartObject, transformSmartObject } from "./smart-object";
import { TileStore } from "./tile-store";
import type { RasterDocumentState } from "./types";

/**
 * The one combination the effects-region and smart-object-region tests didn't cover on their
 * own: `renderLayerEffects`'s own region-cropped fast path calling INTO `layerDocumentPixels`'s
 * smart-transform branch with a cropped `sourceRegion`, reached only when a smart-transformed,
 * effect-bearing layer is composited on a canvas large enough to trigger `compositeInPieces`'s
 * piece subdivision (docs/master-plan.md §37.3 item 2).
 */
describe("a smart-transformed, effect-bearing layer composited in pieces", () => {
  const W = 1024, H = 1024; // area > subdivideAbove (512*512), forces compositeInPieces

  function documentWithTransformedShadowedSmartObject(): RasterDocumentState {
    const state: RasterDocumentState = createRasterDocument(W, H);
    state.layers = [];
    const layer = createRasterLayer(40, 30, "Source");
    const pixels = new Uint8ClampedArray(40 * 30 * 4);
    for (let i = 0; i < 40 * 30; i += 1) { pixels[i * 4] = 200; pixels[i * 4 + 1] = 80; pixels[i * 4 + 2] = 60; pixels[i * 4 + 3] = 255; }
    layer.tiles = TileStore.fromPixels(pixels, 40, 30);
    convertLayerToEmbeddedSmartObject(layer, "asset-source");
    // transformSmartObject also derives layer.bounds from the transform (smart-object.ts's own
    // invariant) — setting layer.smartTransform directly and skipping this call is what a
    // browser-console reproduction of this test got wrong, not the region-cropped code path.
    transformSmartObject(layer, { x: 0, y: 0, width: 40, height: 30 }, { x: 300, y: 200, width: 100, height: 75 }, 0);
    layer.effects = { dropShadow: { enabled: true, color: "#ff0000", opacity: 1, offsetX: 20, offsetY: 20 } };
    appendLayer(state, layer);
    return state;
  }

  it("has visible content at all (a real regression here renders nothing)", () => {
    const composite = compositeRasterDocument(documentWithTransformedShadowedSmartObject());
    let anyOpaque = false;
    for (let i = 3; i < composite.length; i += 4) if (composite[i]! > 0) { anyOpaque = true; break; }
    expect(anyOpaque).toBe(true);
  });

  it("a piece cut from the subdivided full composite matches the same region composited directly", () => {
    const state = documentWithTransformedShadowedSmartObject();
    // Covers part of the placed square (300,200)-(400,275) and part of its shadow, offset (20,20).
    const region = { x: 280, y: 180, width: 200, height: 200 };

    const full = compositeRasterDocument(state); // internally subdivided (W*H > subdivideAbove)
    const cropOfFull = new Uint8ClampedArray(region.width * region.height * 4);
    for (let y = 0; y < region.height; y += 1) {
      const from = ((region.y + y) * W + region.x) * 4;
      cropOfFull.set(full.subarray(from, from + region.width * 4), y * region.width * 4);
    }

    // Requested directly: 200*200 = 40000 < subdivideAbove, so this takes the single-pass branch —
    // an independent computation of the same pixels, not subject to the same subdivision code path.
    const direct = compositeRasterRegion(state, region);

    expect(direct).toEqual(cropOfFull);
  });
});
