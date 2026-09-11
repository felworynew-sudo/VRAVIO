import { describe, expect, it } from "vitest";
import type { RasterLayer } from "@vravio/env-raster";
import { documentMaskFromLayerMask } from "./RasterPixelLayerProperties";

const layerAt = (x: number, y: number, width: number, height: number): RasterLayer => ({
  id: "layer", name: "Layer", bounds: { x, y, width, height }, width, height,
  pixels: new Uint8ClampedArray(width * height * 4), visible: true, opacity: 1, fillOpacity: 1,
  blendMode: "normal", locked: false, kind: "pixel", effects: {}, parentId: null, orderKey: "0", clipping: false,
});

describe("documentMaskFromLayerMask", () => {
  it("places a layer-local mask at the layer's own offset in document space", () => {
    const layer = layerAt(10, 5, 2, 2);
    const layerMask = Uint8ClampedArray.from([255, 128, 64, 32]); // row-major, 2x2
    const documentMask = documentMaskFromLayerMask(layerMask, layer, 20, 10);

    expect(documentMask[5 * 20 + 10]).toBe(255);
    expect(documentMask[5 * 20 + 11]).toBe(128);
    expect(documentMask[6 * 20 + 10]).toBe(64);
    expect(documentMask[6 * 20 + 11]).toBe(32);
    // Everywhere else stays zero — nothing outside the layer's own bounds is touched.
    expect(documentMask[0]).toBe(0);
    expect(documentMask.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0)).toBe(4);
  });

  it("clips a layer that hangs off the document edge instead of throwing or wrapping", () => {
    const layer = layerAt(-1, -1, 3, 3);
    const layerMask = new Uint8ClampedArray(9).fill(200);
    const documentMask = documentMaskFromLayerMask(layerMask, layer, 2, 2);

    // Local (1,1)..(2,2) — the layer's bottom-right 2x2 — is the only part
    // that lands inside doc coordinates [0,2)x[0,2); the top-left row/column
    // of the layer falls at doc x/y -1 and is dropped, not wrapped.
    expect(documentMask.every((value) => value === 200)).toBe(true);
    expect(documentMask.length).toBe(4);
  });

  it("returns an all-zero buffer when the layer lies entirely outside the document", () => {
    const layer = layerAt(100, 100, 4, 4);
    const layerMask = new Uint8ClampedArray(16).fill(255);
    const documentMask = documentMaskFromLayerMask(layerMask, layer, 10, 10);

    expect(documentMask.every((value) => value === 0)).toBe(true);
  });
});
