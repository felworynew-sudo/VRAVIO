import { describe, expect, it } from "vitest";
import { createAdjustmentLayer, createRasterDocument, createRasterGroup, createRasterLayer, createRasterLayerMask } from "./document";
import { appendLayer, pickLayerAt } from "./layer-tree";
import type { RasterDocumentState, RasterLayer } from "./types";

const W = 32, H = 32;

const paint = (layer: RasterLayer, x0: number, y0: number, size: number, alpha = 255) => {
  for (let y = y0; y < y0 + size; y += 1) for (let x = x0; x < x0 + size; x += 1) {
    const index = (y * W + x) * 4;
    layer.pixels[index] = 200; layer.pixels[index + 1] = 40; layer.pixels[index + 2] = 40; layer.pixels[index + 3] = alpha;
  }
};

const scene = (): RasterDocumentState => createRasterDocument(W, H);

const add = (state: RasterDocumentState, name: string, mutate?: (layer: RasterLayer) => void, parentId: string | null = null) => {
  const layer = createRasterLayer(W, H, name);
  mutate?.(layer);
  appendLayer(state, layer, parentId);
  return layer;
};

describe("picking the layer under a click", () => {
  it("finds the layer whose pixels are there", () => {
    const state = scene();
    const left = add(state, "Left", (layer) => paint(layer, 2, 2, 8));
    const right = add(state, "Right", (layer) => paint(layer, 20, 20, 8));

    // The complaint this exists for: with one shape selected, clicking the other
    // has to move the other, not the selection in the panel.
    expect(pickLayerAt(state, 4, 4)?.id).toBe(left.id);
    expect(pickLayerAt(state, 22, 22)?.id).toBe(right.id);
  });

  it("prefers the topmost of two that overlap", () => {
    const state = scene();
    add(state, "Under", (layer) => paint(layer, 4, 4, 12));
    const over = add(state, "Over", (layer) => paint(layer, 8, 8, 12));

    expect(pickLayerAt(state, 10, 10)?.id).toBe(over.id);
  });

  it("returns nothing where the document is empty", () => {
    const state = scene();
    add(state, "Corner", (layer) => paint(layer, 0, 0, 4));

    expect(pickLayerAt(state, 20, 20)).toBeNull();
  });

  it("ignores a hidden layer and one inside a hidden group", () => {
    const state = scene();
    const under = add(state, "Under", (layer) => paint(layer, 4, 4, 12));
    add(state, "Hidden", (layer) => { paint(layer, 4, 4, 12); layer.visible = false; });

    expect(pickLayerAt(state, 8, 8)?.id).toBe(under.id);

    const group = createRasterGroup(W, H, "Group");
    group.visible = false;
    appendLayer(state, group);
    add(state, "Inside", (layer) => paint(layer, 4, 4, 12), group.id);

    expect(pickLayerAt(state, 8, 8)?.id).toBe(under.id);
  });

  it("never picks a group or an adjustment", () => {
    const state = scene();
    const pixels = add(state, "Pixels", (layer) => paint(layer, 4, 4, 12));
    const group = createRasterGroup(W, H, "Group");
    appendLayer(state, group);
    appendLayer(state, createAdjustmentLayer(W, H, "invert", "Invert"));

    // A group has no pixels of its own and an adjustment covers the whole
    // canvas: picking either would put everything underneath out of reach.
    expect(pickLayerAt(state, 8, 8)?.id).toBe(pixels.id);
  });

  it("skips a layer its mask has hidden at that point", () => {
    const state = scene();
    const under = add(state, "Under", (layer) => paint(layer, 4, 4, 12));
    add(state, "Masked", (layer) => {
      paint(layer, 4, 4, 12);
      layer.mask = createRasterLayerMask(W, H);
      layer.mask.pixels.fill(0);
    });

    expect(pickLayerAt(state, 8, 8)?.id).toBe(under.id);
  });

  it("skips what is too faint to be worth grabbing", () => {
    const state = scene();
    const solid = add(state, "Solid", (layer) => paint(layer, 4, 4, 12));
    add(state, "Faint", (layer) => { paint(layer, 4, 4, 12); layer.opacity = 0.2; });

    // Antialiased edges fade over a pixel or two; picking at the first hint of
    // alpha means a click near an outline grabs the shape instead of what is
    // visible behind it.
    expect(pickLayerAt(state, 8, 8)?.id).toBe(solid.id);
    expect(pickLayerAt(state, 8, 8, { threshold: 0.1 })?.name).toBe("Faint");
  });

  it("accounts for fill opacity as well as layer opacity", () => {
    const state = scene();
    const solid = add(state, "Solid", (layer) => paint(layer, 4, 4, 12));
    add(state, "Half", (layer) => { paint(layer, 4, 4, 12); layer.opacity = 0.8; layer.fillOpacity = 0.4; });

    expect(pickLayerAt(state, 8, 8)?.id).toBe(solid.id);
  });

  it("returns the outermost group when asked for a group", () => {
    const state = scene();
    const outer = createRasterGroup(W, H, "Outer");
    appendLayer(state, outer);
    const inner = createRasterGroup(W, H, "Inner");
    appendLayer(state, inner, outer.id);
    const leaf = add(state, "Leaf", (layer) => paint(layer, 4, 4, 12), inner.id);

    expect(pickLayerAt(state, 8, 8, { target: "group" })?.id).toBe(outer.id);
    expect(pickLayerAt(state, 8, 8, { target: "layer" })?.id).toBe(leaf.id);
  });

  it("returns the layer itself when it belongs to no group", () => {
    const state = scene();
    const loose = add(state, "Loose", (layer) => paint(layer, 4, 4, 12));

    expect(pickLayerAt(state, 8, 8, { target: "group" })?.id).toBe(loose.id);
  });

  it("returns nothing for a point outside the document", () => {
    const state = scene();
    add(state, "Full", (layer) => paint(layer, 0, 0, W));

    for (const [x, y] of [[-1, 5], [5, -1], [W, 5], [5, H]]) expect(pickLayerAt(state, x!, y!)).toBeNull();
  });
});
