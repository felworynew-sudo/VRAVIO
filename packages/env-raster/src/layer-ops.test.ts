import { describe, expect, it } from "vitest";
import {
  appendLayer, createRasterDocument, createRasterGroup, createRasterLayer, createRasterLayerMask,
  createRectangleSelection, duplicateLayer, groupLayers, layerFromSelection, mergeLayerDown,
  mergeVisibleLayers, moveLayerInStack, placeLayer, rasterLayerRows, stampVisibleLayers, ungroupLayer,
  dropPositionInRow, dropTargetForRow, toggleLayerLink, linkedLayers, layerDocumentPixels,
} from "./index";
import type { RasterDocumentState, RasterLayer } from "./types";

const W = 16, H = 16;

const fill = (layer: RasterLayer, r: number, g: number, b: number, a = 255) => {
  for (let index = 0; index < layer.pixels.length; index += 4) {
    layer.pixels[index] = r; layer.pixels[index + 1] = g; layer.pixels[index + 2] = b; layer.pixels[index + 3] = a;
  }
  return layer;
};

const doc = (): RasterDocumentState => {
  const state = createRasterDocument(W, H);
  state.layers = [];
  return state;
};

const add = (state: RasterDocumentState, name: string, mutate?: (layer: RasterLayer) => void, parentId: string | null = null) => {
  const layer = createRasterLayer(W, H, name);
  mutate?.(layer);
  appendLayer(state, layer, parentId);
  return layer;
};

const names = (state: RasterDocumentState) => rasterLayerRows(state.layers).map((row) => row.layer.name);
const first = (layer: RasterLayer) => [layer.pixels[0], layer.pixels[1], layer.pixels[2], layer.pixels[3]];

describe("duplicating a layer", () => {
  it("puts the copy directly above the original", () => {
    const state = doc();
    add(state, "Bottom");
    const middle = add(state, "Middle");
    add(state, "Top");

    duplicateLayer(state, middle.id);

    expect(names(state)).toEqual(["Top", "Middle copy (копия)", "Middle", "Bottom"]);
  });

  it("gives the copy its own pixels", () => {
    const state = doc();
    const source = add(state, "Source", (layer) => fill(layer, 10, 20, 30));

    const copy = duplicateLayer(state, source.id)!;
    copy.pixels[0] = 200;

    // Sharing the buffer would make the two layers the same layer as soon as
    // either was painted on.
    expect(source.pixels[0]).toBe(10);
    expect(copy.pixels).not.toBe(source.pixels);
  });

  it("copies the mask and drops the asset binding", () => {
    const state = doc();
    const source = add(state, "Source", (layer) => {
      layer.mask = createRasterLayerMask(W, H);
      layer.mask.pixels.fill(128);
      layer.pixelAssetId = "asset-1";
    });

    const copy = duplicateLayer(state, source.id)!;

    expect(copy.mask?.pixels[0]).toBe(128);
    expect(copy.mask?.pixels).not.toBe(source.mask?.pixels);
    // The copy is a new buffer and must not claim the original's revisions.
    expect(copy.pixelAssetId).toBeUndefined();
  });

  it("copies a group along with everything in it", () => {
    const state = doc();
    const group = createRasterGroup(W, H, "Group");
    appendLayer(state, group);
    add(state, "Inside", undefined, group.id);

    const copy = duplicateLayer(state, group.id)!;

    expect(state.layers.filter((layer) => layer.parentId === copy.id)).toHaveLength(1);
    expect(state.layers).toHaveLength(4);
  });

  it("selects the copy", () => {
    const state = doc();
    const source = add(state, "Source");

    expect(duplicateLayer(state, source.id)!.id).toBe(state.activeLayerId);
  });
});

describe("merging down", () => {
  it("composites the pair and keeps the lower layer", () => {
    const state = doc();
    const lower = add(state, "Lower", (layer) => fill(layer, 255, 0, 0));
    const upper = add(state, "Upper", (layer) => { fill(layer, 0, 0, 255); layer.opacity = 0.5; });

    const merged = mergeLayerDown(state, upper.id)!;

    expect(merged.id).toBe(lower.id);
    expect(state.layers).toHaveLength(1);
    // Half blue over red: the merge has to honour opacity, not just copy pixels.
    expect(merged.pixels[0]).toBeGreaterThan(100);
    expect(merged.pixels[2]).toBeGreaterThan(100);
    expect(merged.opacity).toBe(1);
    expect(merged.blendMode).toBe("normal");
  });

  it("refuses when there is nothing underneath", () => {
    const state = doc();
    const only = add(state, "Only");

    expect(mergeLayerDown(state, only.id)).toBeNull();
    expect(state.layers).toHaveLength(1);
  });

  it("refuses to merge a group", () => {
    const state = doc();
    add(state, "Under");
    const group = createRasterGroup(W, H, "Group");
    appendLayer(state, group);

    expect(mergeLayerDown(state, group.id)).toBeNull();
  });
});

describe("merging and stamping what is visible", () => {
  it("leaves hidden layers alone", () => {
    const state = doc();
    add(state, "Visible A", (layer) => fill(layer, 255, 0, 0));
    add(state, "Hidden", (layer) => { fill(layer, 0, 255, 0); layer.visible = false; });
    add(state, "Visible B", (layer) => fill(layer, 0, 0, 255, 128));

    mergeVisibleLayers(state);

    expect(names(state)).toEqual(["Hidden", "Visible A"]);
  });

  it("does nothing when only one layer is visible", () => {
    const state = doc();
    add(state, "Only", (layer) => fill(layer, 1, 2, 3));

    expect(mergeVisibleLayers(state)).toBeNull();
    expect(state.layers).toHaveLength(1);
  });

  it("stamps a flattened copy above without removing anything", () => {
    const state = doc();
    add(state, "A", (layer) => fill(layer, 255, 0, 0));
    add(state, "B", (layer) => fill(layer, 0, 0, 255, 128));

    const stamp = stampVisibleLayers(state)!;

    expect(names(state)[0]).toBe("Merged (Объединённое)");
    expect(state.layers).toHaveLength(3);
    expect(first(stamp)[3]).toBe(255);
  });

  it("stamps nothing when nothing is visible", () => {
    const state = doc();
    add(state, "A", (layer) => { layer.visible = false; });

    expect(stampVisibleLayers(state)).toBeNull();
  });
});

describe("grouping", () => {
  it("puts the chosen layers into a group in their place", () => {
    const state = doc();
    add(state, "Bottom");
    const one = add(state, "One");
    const two = add(state, "Two");
    add(state, "Top");

    const group = groupLayers(state, [one.id, two.id], "Group")!;

    expect(names(state)).toEqual(["Top", "Group", "Two", "One", "Bottom"]);
    expect(state.activeLayerId).toBe(group.id);
  });

  it("ignores layers from another branch rather than tearing the tree", () => {
    const state = doc();
    const outer = createRasterGroup(W, H, "Outer");
    appendLayer(state, outer);
    const inside = add(state, "Inside", undefined, outer.id);
    const loose = add(state, "Loose");

    const group = groupLayers(state, [inside.id, loose.id])!;

    // Both cannot go in one group without moving one across branches, so the
    // group forms where the topmost member already lives.
    expect(state.layers.filter((layer) => layer.parentId === group.id).map((layer) => layer.name)).toEqual(["Loose"]);
    expect(inside.parentId).toBe(outer.id);
  });

  it("ungroups back into the parent, in order", () => {
    const state = doc();
    add(state, "Bottom");
    const one = add(state, "One");
    const two = add(state, "Two");
    add(state, "Top");
    const group = groupLayers(state, [one.id, two.id])!;

    expect(ungroupLayer(state, group.id)).toBe(true);
    expect(names(state)).toEqual(["Top", "Two", "One", "Bottom"]);
  });

  it("refuses to ungroup something that is not a group", () => {
    const state = doc();
    const layer = add(state, "Plain");

    expect(ungroupLayer(state, layer.id)).toBe(false);
  });
});

describe("reordering", () => {
  const stack = () => {
    const state = doc();
    add(state, "A"); add(state, "B"); add(state, "C"); add(state, "D");
    return state;
  };

  it("steps a layer up and down", () => {
    const state = stack();
    const b = state.layers.find((layer) => layer.name === "B")!;

    // Panel order is topmost first, so moving B up puts it above C.
    moveLayerInStack(state, b.id, "up");
    expect(names(state)).toEqual(["D", "B", "C", "A"]);
    moveLayerInStack(state, b.id, "down");
    expect(names(state)).toEqual(["D", "C", "B", "A"]);
  });

  it("sends a layer to the front and the back", () => {
    const state = stack();
    const b = state.layers.find((layer) => layer.name === "B")!;

    moveLayerInStack(state, b.id, "top");
    expect(names(state)).toEqual(["B", "D", "C", "A"]);
    moveLayerInStack(state, b.id, "bottom");
    expect(names(state)).toEqual(["D", "C", "A", "B"]);
  });

  it("does nothing at the ends", () => {
    const state = stack();
    const top = state.layers.find((layer) => layer.name === "D")!;

    expect(moveLayerInStack(state, top.id, "up")).toBe(false);
    expect(names(state)).toEqual(["D", "C", "B", "A"]);
  });

  it("keeps a layer inside its group", () => {
    const state = doc();
    add(state, "Outside");
    const group = createRasterGroup(W, H, "Group");
    appendLayer(state, group);
    const inside = add(state, "Inside", undefined, group.id);

    expect(moveLayerInStack(state, inside.id, "top")).toBe(false);
    expect(inside.parentId).toBe(group.id);
  });

  it("drops a layer at an explicit place for a drag", () => {
    const state = stack();
    const d = state.layers.find((layer) => layer.name === "D")!;

    expect(placeLayer(state, d.id, null, 0)).toBe(true);
    expect(names(state)).toEqual(["C", "B", "A", "D"]);
  });

  it("moves a layer into a group by dropping it there", () => {
    const state = doc();
    const group = createRasterGroup(W, H, "Group");
    appendLayer(state, group);
    const loose = add(state, "Loose");

    expect(placeLayer(state, loose.id, group.id, 0)).toBe(true);
    expect(loose.parentId).toBe(group.id);
  });

  it("refuses to drop a group inside itself", () => {
    const state = doc();
    const outer = createRasterGroup(W, H, "Outer");
    appendLayer(state, outer);
    const inner = createRasterGroup(W, H, "Inner");
    appendLayer(state, inner, outer.id);

    // Either of these would turn the tree into a cycle and hang every walk of it.
    expect(placeLayer(state, outer.id, outer.id, 0)).toBe(false);
    expect(placeLayer(state, outer.id, inner.id, 0)).toBe(false);
  });
});

describe("layer via copy and cut", () => {
  const selected = () => createRectangleSelection(W, H, 0, 0, 8, 16);
  // Layers are stored at the size of their content, so what these assertions
  // are about — where the pixels sit on the canvas — is read in canvas space.
  const canvas = (layer: RasterLayer) => layerDocumentPixels(layer, W, H);

  it("lifts the selected pixels onto a new layer above", () => {
    const state = doc();
    const source = add(state, "Source", (layer) => fill(layer, 200, 100, 50));

    const lifted = layerFromSelection(state, source.id, selected())!;

    expect(names(state)).toEqual(["Layer via Copy (Слой копированием)", "Source"]);
    expect(canvas(lifted)[3]).toBe(255);
    // Outside the selection the new layer holds nothing.
    expect(canvas(lifted)[(0 * W + 12) * 4 + 3]).toBe(0);
    expect(canvas(source)[3]).toBe(255);
  });

  it("clears what it took when cutting", () => {
    const state = doc();
    const source = add(state, "Source", (layer) => fill(layer, 200, 100, 50));

    const lifted = layerFromSelection(state, source.id, selected(), true)!;

    expect(canvas(lifted)[3]).toBe(255);
    expect(canvas(source)[3]).toBe(0);
    // Untouched outside the selection.
    expect(canvas(source)[(0 * W + 12) * 4 + 3]).toBe(255);
  });

  it("splits a partially selected pixel between the two", () => {
    const state = doc();
    const source = add(state, "Source", (layer) => fill(layer, 10, 10, 10));
    const soft = createRectangleSelection(W, H, 0, 0, 8, 16, 3);

    const lifted = layerFromSelection(state, source.id, soft, true)!;

    const liftedCanvas = canvas(lifted), sourceCanvas = canvas(source);
    for (let index = 3; index < liftedCanvas.length; index += 4) {
      // A feathered edge has to stay continuous across the pair: what one takes
      // is exactly what the other loses.
      expect(liftedCanvas[index]! + sourceCanvas[index]!).toBeGreaterThanOrEqual(254);
      expect(liftedCanvas[index]! + sourceCanvas[index]!).toBeLessThanOrEqual(256);
    }
  });

  it("duplicates the layer when nothing is selected", () => {
    const state = doc();
    const source = add(state, "Source", (layer) => fill(layer, 1, 2, 3));

    const copy = layerFromSelection(state, source.id, null)!;

    expect(copy.name).toBe("Source copy (копия)");
    expect(state.layers).toHaveLength(2);
  });

  it("cuts nothing when nothing is selected", () => {
    const state = doc();
    const source = add(state, "Source");

    expect(layerFromSelection(state, source.id, null, true)).toBeNull();
  });
});

describe("dropping a dragged row", () => {
  const stack = () => {
    const state = doc();
    add(state, "A"); add(state, "B"); add(state, "C");
    return state;
  };

  it("reads which third of a row the pointer is over", () => {
    expect(dropPositionInRow(2, 30, false)).toBe("above");
    expect(dropPositionInRow(25, 30, false)).toBe("below");
    // A group has a middle band, which is the only way to drop into a
    // collapsed one by dragging.
    expect(dropPositionInRow(15, 30, true)).toBe("into");
    expect(dropPositionInRow(2, 30, true)).toBe("above");
    expect(dropPositionInRow(28, 30, true)).toBe("below");
  });

  it("survives a row with no height", () => {
    expect(dropPositionInRow(0, 0, false)).toBe("above");
  });

  it("turns a drop above a row into the place just over it", () => {
    const state = stack();
    const b = state.layers.find((layer) => layer.name === "B")!;
    const a = state.layers.find((layer) => layer.name === "A")!;

    // The panel lists layers topmost first while the tree stores them bottom-up,
    // so "above B" is a higher index than B.
    placeLayer(state, a.id, ...Object.values(dropTargetForRow(state, b.id, "above")!) as [string | null, number]);
    expect(names(state)).toEqual(["C", "A", "B"]);
  });

  it("turns a drop below a row into the place just under it", () => {
    const state = stack();
    const c = state.layers.find((layer) => layer.name === "C")!;
    const a = state.layers.find((layer) => layer.name === "A")!;

    const target = dropTargetForRow(state, c.id, "below")!;
    placeLayer(state, a.id, target.parentId, target.index);
    expect(names(state)).toEqual(["C", "A", "B"]);
  });

  it("drops into a group", () => {
    const state = doc();
    const group = createRasterGroup(W, H, "Group");
    appendLayer(state, group);
    const loose = add(state, "Loose");

    const target = dropTargetForRow(state, group.id, "into")!;
    placeLayer(state, loose.id, target.parentId, target.index);

    expect(loose.parentId).toBe(group.id);
  });

  it("refuses to drop into something that is not a group", () => {
    const state = stack();
    const b = state.layers.find((layer) => layer.name === "B")!;

    expect(dropTargetForRow(state, b.id, "into")).toBeNull();
  });

  it("reports nothing for a row that is gone", () => {
    expect(dropTargetForRow(stack(), "missing", "above")).toBeNull();
  });
});

describe("linking layers", () => {
  it("links a pair and moves them as one", () => {
    const state = doc();
    const one = add(state, "One");
    const two = add(state, "Two");
    add(state, "Three");

    expect(toggleLayerLink(state, [one.id, two.id])).toBe(true);
    expect(linkedLayers(state, one.id).map((layer) => layer.name).sort()).toEqual(["One", "Two"]);
    expect(linkedLayers(state, two.id)).toHaveLength(2);
  });

  it("unlinks a pair that is already linked", () => {
    const state = doc();
    const one = add(state, "One");
    const two = add(state, "Two");
    toggleLayerLink(state, [one.id, two.id]);

    expect(toggleLayerLink(state, [one.id, two.id])).toBe(true);
    expect(one.linkGroup).toBeUndefined();
    expect(two.linkGroup).toBeUndefined();
  });

  it("takes one layer out of a link it belongs to", () => {
    const state = doc();
    const one = add(state, "One");
    const two = add(state, "Two");
    const three = add(state, "Three");
    toggleLayerLink(state, [one.id, two.id, three.id]);

    expect(toggleLayerLink(state, [two.id])).toBe(true);
    expect(two.linkGroup).toBeUndefined();
    // The rest keep each other; a shared token means the others need no repair.
    expect(linkedLayers(state, one.id).map((layer) => layer.name).sort()).toEqual(["One", "Three"]);
  });

  it("joins layers that were in different links", () => {
    const state = doc();
    const one = add(state, "One");
    const two = add(state, "Two");
    const three = add(state, "Three");
    const four = add(state, "Four");
    toggleLayerLink(state, [one.id, two.id]);
    toggleLayerLink(state, [three.id, four.id]);

    toggleLayerLink(state, [two.id, three.id]);

    expect(two.linkGroup).toBe(three.linkGroup);
    expect(two.linkGroup).not.toBe(one.linkGroup);
  });

  it("reports an unlinked layer as alone", () => {
    const state = doc();
    const only = add(state, "Only");

    expect(linkedLayers(state, only.id).map((layer) => layer.name)).toEqual(["Only"]);
    expect(toggleLayerLink(state, [only.id])).toBe(false);
  });

  it("knows nothing about a layer that is gone", () => {
    expect(linkedLayers(doc(), "missing")).toEqual([]);
  });
});
