import { describe, expect, it } from "vitest";
import { createRasterDocument, createRasterLayer } from "@vravio/env-raster";
import { canDirectRasterPreviewBlit } from "./raster-commit";

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
