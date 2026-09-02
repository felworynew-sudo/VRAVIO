import { describe, expect, it } from "vitest";
import { appendLayer, changedRenderRegion, createAdjustmentLayer, createRasterDocument, createRasterLayer, layerRenderSignatures } from "./index";
import type { RasterDocumentState, RasterLayer } from "./types";

const W = 64, H = 64;

const paint = (layer: RasterLayer, x0: number, y0: number, size: number) => {
  for (let y = y0; y < y0 + size; y += 1) for (let x = x0; x < x0 + size; x += 1) {
    const at = (y * W + x) * 4;
    layer.pixels[at] = 200; layer.pixels[at + 1] = 80; layer.pixels[at + 2] = 60; layer.pixels[at + 3] = 255;
  }
};

const scene = () => {
  const state = createRasterDocument(W, H);
  state.layers = [];
  const lower = createRasterLayer(W, H, "Lower");
  paint(lower, 4, 4, 10);
  appendLayer(state, lower);
  const upper = createRasterLayer(W, H, "Upper");
  paint(upper, 40, 40, 12);
  appendLayer(state, upper);
  return { state, lower, upper };
};

const region = (state: RasterDocumentState, before: ReturnType<typeof layerRenderSignatures>) =>
  changedRenderRegion(before, layerRenderSignatures(state), state);

describe("what changed between two renders", () => {
  it("reports nothing when nothing changed", () => {
    const { state } = scene();
    const before = layerRenderSignatures(state);

    expect(region(state, before)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("bounds a changed layer to where its content is", () => {
    const { state, upper } = scene();
    const before = layerRenderSignatures(state);
    upper.opacity = 0.4;

    // Changing an opacity used to repaint the whole document because nothing
    // reported a region for it.
    expect(region(state, before)).toEqual({ x: 40, y: 40, width: 12, height: 12 });
  });

  it("covers where the content was and where it went", () => {
    const { state, upper } = scene();
    const before = layerRenderSignatures(state);
    const moved = createRasterLayer(W, H, "Upper");
    paint(moved, 20, 20, 12);
    upper.pixels = moved.pixels;

    expect(region(state, before)).toEqual({ x: 20, y: 20, width: 32, height: 32 });
  });

  it("bounds a hidden layer to what it was covering", () => {
    const { state, lower } = scene();
    const before = layerRenderSignatures(state);
    lower.visible = false;

    expect(region(state, before)).toEqual({ x: 4, y: 4, width: 10, height: 10 });
  });

  it("gives up when the layer set changes", () => {
    const { state } = scene();
    const before = layerRenderSignatures(state);
    appendLayer(state, createRasterLayer(W, H, "New"));

    // Added, removed, reordered or regrouped: the sequences diverge and there is
    // no honest bound left.
    expect(region(state, before)).toBeNull();
  });

  it("gives up for an adjustment layer", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const adjustment = createAdjustmentLayer(W, H, "invert", "Invert");
    appendLayer(state, adjustment);
    const before = layerRenderSignatures(state);
    adjustment.opacity = 0.5;

    // An adjustment reads back everything composited beneath it, so its effect
    // is not bounded by its own pixels.
    expect(region(state, before)).toBeNull();
  });

  it("gives up for a layer carrying an effect", () => {
    const { state, upper } = scene();
    upper.effects = { dropShadow: { enabled: true, color: "#000", opacity: 1, offsetX: 8, offsetY: 8 } };
    const before = layerRenderSignatures(state);
    upper.opacity = 0.5;

    // A shadow paints outside the layer's own pixels; guessing smaller than the
    // truth leaves stale pixels on screen, which is worse than repainting more.
    expect(region(state, before)).toBeNull();
  });

  it("gives up when a reorder keeps the same layers", () => {
    const { state, lower, upper } = scene();
    const before = layerRenderSignatures(state);
    const swap = lower.orderKey; lower.orderKey = upper.orderKey; upper.orderKey = swap;

    expect(region(state, before)).toBeNull();
  });
});
