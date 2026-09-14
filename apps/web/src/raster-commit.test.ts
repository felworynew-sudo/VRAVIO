import { createRasterDocument, createRasterLayer, RasterTileCache } from "@vravio/env-raster";
import { describe, expect, it } from "vitest";
import { canDirectRasterPreviewBlit, tilesForCanvasPresentation } from "./raster-commit";

describe("canDirectRasterPreviewBlit", () => {
  it("accepts the one case whose raw pixels equal the compositor", () => {
    const state = createRasterDocument(2, 2);
    expect(canDirectRasterPreviewBlit(state, state.layers[0]!)).toBe(true);
  });

  it.each([
    "mask", "fill", "clipping", "effects", "opacity", "blend", "extra-layer",
  ])("routes %s through the compositor", (variant) => {
    const state = createRasterDocument(2, 2);
    const layer = state.layers[0]!;
    if (variant === "mask") layer.mask = { pixels: new Uint8ClampedArray([255, 255, 255, 255]), assetId: null, enabled: true, linked: true, density: 1, feather: 0 };
    if (variant === "fill") layer.fillOpacity = .5;
    if (variant === "clipping") layer.clipping = true;
    if (variant === "effects") layer.effects = { dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX: 1, offsetY: 1 } };
    if (variant === "opacity") layer.opacity = .5;
    if (variant === "blend") layer.blendMode = "multiply";
    if (variant === "extra-layer") state.layers.push(createRasterLayer(2, 2));
    expect(canDirectRasterPreviewBlit(state, layer)).toBe(false);
  });
});

describe("tile canvas presentation", () => {
  it("re-blits cached visible tiles when returning to an earlier mip", () => {
    const document = createRasterDocument(64, 64, { backgroundColor: "#3366ff" });
    const cache = new RasterTileCache({ tileSize: 32 });
    const viewport = { x: 0, y: 0, width: 64, height: 64 };

    cache.update(document, viewport, { mip: 0 });
    cache.update(document, viewport, { mip: 1 });
    const returnedToFullResolution = cache.update(document, viewport, { mip: 0 });

    // The cache did no new composite work, but its valid mip-0 pixels must
    // still replace the stretched mip-1 pixels already painted to canvas.
    expect(returnedToFullResolution.repainted).toHaveLength(0);
    expect(returnedToFullResolution.visible).toHaveLength(4);
    expect(tilesForCanvasPresentation(returnedToFullResolution, true)).toEqual(returnedToFullResolution.visible);
    expect(tilesForCanvasPresentation(returnedToFullResolution, false)).toEqual(returnedToFullResolution.repainted);
  });
});
