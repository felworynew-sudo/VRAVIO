import { describe, expect, it } from "vitest";
import {
  appendLayer, compositeRasterRegion, compositeRasterRegionWithCheckpoint, createAdjustmentLayer,
  createRasterDocument, createRasterGroup, createRasterLayer, createRasterLayerMask, RasterTileCache,
  setLayerPixels,
} from "./index";
import { TileStore } from "./tile-store";
import type { RasterDocumentState, RasterLayer, RasterRect } from "./types";

const W = 40, H = 40;
const AREA: RasterRect = { x: 0, y: 0, width: W, height: H };

function paint(layer: RasterLayer, r: number, g: number, b: number, a = 255): void {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i += 1) { pixels[i * 4] = r; pixels[i * 4 + 1] = g; pixels[i * 4 + 2] = b; pixels[i * 4 + 3] = a; }
  layer.tiles = TileStore.fromPixels(pixels, W, H);
  layer.pixelsRevision += 1;
}

/**
 * docs/master-plan.md §37.3 item 3: `compositeRasterRegionWithCheckpoint` must never produce a
 * different picture from the plain, checkpoint-less `compositeRasterRegion` — a checkpoint may
 * only change how much of the stack gets re-walked, never the result. Every scenario below
 * exercises one of the concrete complications the plan's own research found (clipping's
 * alpha-only base, an adjustment reading everything beneath it, a nested isolated group's own
 * recursive stack, several layers changing in the same commit) and checks the checkpoint-assisted
 * result against a completely fresh recompute of the same state.
 */
describe("compositeRasterRegionWithCheckpoint matches a fresh recompute", () => {
  it("a flat stack: editing the same middle layer twice in a row", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const bottom = createRasterLayer(W, H, "Bottom"); paint(bottom, 10, 20, 30); appendLayer(state, bottom);
    const middle = createRasterLayer(W, H, "Middle"); paint(middle, 200, 0, 0, 128); appendLayer(state, middle);
    const top = createRasterLayer(W, H, "Top"); paint(top, 0, 200, 0, 64); appendLayer(state, top);

    const first = compositeRasterRegionWithCheckpoint(state, AREA, null);
    expect(first.pixels).toEqual(compositeRasterRegion(state, AREA));

    paint(middle, 0, 0, 200, 128);
    const second = compositeRasterRegionWithCheckpoint(state, AREA, first.checkpoint);
    expect(second.pixels).toEqual(compositeRasterRegion(state, AREA));

    paint(middle, 90, 90, 90, 200);
    const third = compositeRasterRegionWithCheckpoint(state, AREA, second.checkpoint);
    expect(third.pixels).toEqual(compositeRasterRegion(state, AREA));
  });

  it("a clipped layer above an edited base preserves the clip relationship", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const base = createRasterLayer(W, H, "Base"); paint(base, 200, 0, 0, 180); appendLayer(state, base);
    const clipped = createRasterLayer(W, H, "Clipped"); paint(clipped, 0, 200, 0, 255); clipped.clipping = true; appendLayer(state, clipped);
    const above = createRasterLayer(W, H, "Above"); paint(above, 0, 0, 200, 100); appendLayer(state, above);

    const first = compositeRasterRegionWithCheckpoint(state, AREA, null);
    expect(first.pixels).toEqual(compositeRasterRegion(state, AREA));

    // Change the clip base itself: its alpha (what `clipped` clips against) must not come from a
    // stale checkpoint here, since the base's own index is exactly where the resume boundary lands.
    paint(base, 200, 0, 0, 90);
    const second = compositeRasterRegionWithCheckpoint(state, AREA, first.checkpoint);
    expect(second.pixels).toEqual(compositeRasterRegion(state, AREA));

    // Now change only the top layer, above the whole clip pair: the checkpoint must resume past
    // the clip pair using its saved `clippingBaseByParent`, not recompute the clip from scratch.
    paint(above, 0, 0, 200, 40);
    const third = compositeRasterRegionWithCheckpoint(state, AREA, second.checkpoint);
    expect(third.pixels).toEqual(compositeRasterRegion(state, AREA));
  });

  it("an adjustment layer above the edited layer keeps reading everything beneath it", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const base = createRasterLayer(W, H, "Base"); paint(base, 50, 60, 70, 255); appendLayer(state, base);
    const adjustment = createAdjustmentLayer(W, H, "invert", "Invert"); appendLayer(state, adjustment);
    const top = createRasterLayer(W, H, "Top"); paint(top, 0, 0, 0, 30); appendLayer(state, top);

    const first = compositeRasterRegionWithCheckpoint(state, AREA, null);
    expect(first.pixels).toEqual(compositeRasterRegion(state, AREA));

    // The edited layer sits below the adjustment: a checkpoint resuming past this point still has
    // to re-run the adjustment, since its own contribution depends on the base having changed.
    paint(base, 90, 10, 200, 255);
    const second = compositeRasterRegionWithCheckpoint(state, AREA, first.checkpoint);
    expect(second.pixels).toEqual(compositeRasterRegion(state, AREA));

    // Now edit only the layer above the adjustment: the checkpoint must resume past the
    // adjustment's own already-baked contribution instead of re-running it.
    paint(top, 0, 0, 0, 80);
    const third = compositeRasterRegionWithCheckpoint(state, AREA, second.checkpoint);
    expect(third.pixels).toEqual(compositeRasterRegion(state, AREA));
  });

  it("a nested isolated group: editing one child reuses the outer stack around the group", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const below = createRasterLayer(W, H, "Below"); paint(below, 10, 10, 10, 255); appendLayer(state, below);
    const group = createRasterGroup(W, H, "Group"); group.groupMode = "isolated"; appendLayer(state, group);
    const childA = createRasterLayer(W, H, "Child A"); paint(childA, 200, 0, 0, 200); appendLayer(state, childA, group.id);
    const childB = createRasterLayer(W, H, "Child B"); paint(childB, 0, 200, 0, 120); appendLayer(state, childB, group.id);
    const above = createRasterLayer(W, H, "Above"); paint(above, 0, 0, 200, 60); appendLayer(state, above);

    const first = compositeRasterRegionWithCheckpoint(state, AREA, null);
    expect(first.pixels).toEqual(compositeRasterRegion(state, AREA));

    // Edit the second child inside the group: the outer checkpoint's own boundary sits before the
    // group (its signature list still includes every descendant, so the mismatch is found at
    // childB's index, inside the group's own range) — the group's *own* recursive checkpoint is
    // what actually has to do useful work here.
    paint(childB, 0, 90, 90, 120);
    const second = compositeRasterRegionWithCheckpoint(state, AREA, first.checkpoint);
    expect(second.pixels).toEqual(compositeRasterRegion(state, AREA));

    // And a layer entirely outside the group, after it: resumes past the whole group using its
    // carried-forward inner checkpoint untouched.
    paint(above, 0, 0, 200, 200);
    const third = compositeRasterRegionWithCheckpoint(state, AREA, second.checkpoint);
    expect(third.pixels).toEqual(compositeRasterRegion(state, AREA));
  });

  it("several layers changing in one commit (a linked-layer move's shape) still matches a fresh recompute", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const a = createRasterLayer(W, H, "A"); paint(a, 10, 10, 10, 255); appendLayer(state, a);
    const b = createRasterLayer(W, H, "B"); paint(b, 200, 0, 0, 150); appendLayer(state, b);
    const c = createRasterLayer(W, H, "C"); paint(c, 0, 200, 0, 100); appendLayer(state, c);
    const d = createRasterLayer(W, H, "D"); paint(d, 0, 0, 200, 50); appendLayer(state, d);

    const first = compositeRasterRegionWithCheckpoint(state, AREA, null);
    expect(first.pixels).toEqual(compositeRasterRegion(state, AREA));

    // b and d change together; a and c do not — the checkpoint has only one resume boundary, so
    // it must fall back to the earliest of the two (b), not assume only one layer ever changes.
    paint(b, 90, 90, 0, 150);
    paint(d, 0, 90, 90, 50);
    const second = compositeRasterRegionWithCheckpoint(state, AREA, first.checkpoint);
    expect(second.pixels).toEqual(compositeRasterRegion(state, AREA));
  });

  it("a mask enabled between two composites is not masked by a stale checkpoint", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const base = createRasterLayer(W, H, "Base"); paint(base, 10, 10, 10, 255); appendLayer(state, base);
    const layer = createRasterLayer(W, H, "Layer"); paint(layer, 200, 0, 0, 255); appendLayer(state, layer);

    const first = compositeRasterRegionWithCheckpoint(state, AREA, null);
    expect(first.pixels).toEqual(compositeRasterRegion(state, AREA));

    layer.mask = createRasterLayerMask(W, H, false);
    const second = compositeRasterRegionWithCheckpoint(state, AREA, first.checkpoint);
    expect(second.pixels).toEqual(compositeRasterRegion(state, AREA));
  });
});

describe("a checkpoint's boundary relocates to wherever the edit actually is", () => {
  it("resumes fast once the same layer is edited twice, and relocates correctly when a different, earlier layer is edited instead", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const bottom = createRasterLayer(W, H, "Bottom"); paint(bottom, 10, 20, 30); appendLayer(state, bottom);
    const middle = createRasterLayer(W, H, "Middle"); paint(middle, 200, 0, 0, 128); appendLayer(state, middle);
    const top = createRasterLayer(W, H, "Top"); paint(top, 0, 200, 0, 64); appendLayer(state, top);

    // First composite: no signal yet, boundary defaults to "everything".
    let result = compositeRasterRegionWithCheckpoint(state, AREA, null);
    expect(result.checkpoint?.signatures.length).toBe(3);
    expect(result.pixels).toEqual(compositeRasterRegion(state, AREA));

    // Editing `top` (the last layer): the boundary relocates to top's own index (2).
    paint(top, 0, 0, 200, 64);
    result = compositeRasterRegionWithCheckpoint(state, AREA, result.checkpoint);
    expect(result.checkpoint?.signatures.length).toBe(2);
    expect(result.pixels).toEqual(compositeRasterRegion(state, AREA));

    // Editing `top` again: the boundary the previous call left behind (2) is exactly right, so
    // this resumes from it and the saved boundary stays at 2.
    paint(top, 90, 90, 0, 64);
    result = compositeRasterRegionWithCheckpoint(state, AREA, result.checkpoint);
    expect(result.checkpoint?.signatures.length).toBe(2);
    expect(result.pixels).toEqual(compositeRasterRegion(state, AREA));

    // Now editing `bottom` instead — earlier than the current boundary (2): the checkpoint from
    // the previous step cannot be resumed from at all (its snapshot is only valid at index 2, not
    // at bottom's index 0), so this forces a full walk and relocates the boundary down to 0.
    paint(bottom, 5, 5, 5, 255);
    result = compositeRasterRegionWithCheckpoint(state, AREA, result.checkpoint);
    expect(result.checkpoint?.signatures.length).toBe(0);
    expect(result.pixels).toEqual(compositeRasterRegion(state, AREA));
  });
});

describe("a mismatched checkpoint is safely ignored, not corrupting or crashing", () => {
  it("a checkpoint built for a different-sized region is not reused", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const bottom = createRasterLayer(W, H, "Bottom"); paint(bottom, 10, 20, 30); appendLayer(state, bottom);
    const top = createRasterLayer(W, H, "Top"); paint(top, 200, 0, 0, 128); appendLayer(state, top);

    const smallRegionCheckpoint = compositeRasterRegionWithCheckpoint(state, { x: 0, y: 0, width: 10, height: 10 }, null).checkpoint;
    const result = compositeRasterRegionWithCheckpoint(state, AREA, smallRegionCheckpoint);

    expect(result.pixels).toEqual(compositeRasterRegion(state, AREA));
  });

  it("a checkpoint with more layers than the current stack is not reused", () => {
    const state = createRasterDocument(W, H);
    state.layers = [];
    const a = createRasterLayer(W, H, "A"); paint(a, 10, 20, 30); appendLayer(state, a);
    const b = createRasterLayer(W, H, "B"); paint(b, 200, 0, 0, 128); appendLayer(state, b);
    const withBoth = compositeRasterRegionWithCheckpoint(state, AREA, null).checkpoint;

    state.layers = state.layers.filter((layer) => layer.id !== b.id);
    const result = compositeRasterRegionWithCheckpoint(state, AREA, withBoth);

    expect(result.pixels).toEqual(compositeRasterRegion(state, AREA));
  });
});

describe("RasterTileCache uses the checkpoint end to end", () => {
  it("a repeated single-layer edit through update() matches a fresh composite", () => {
    const state: RasterDocumentState = createRasterDocument(120, 120);
    state.layers = [];
    const bottom = createRasterLayer(120, 120, "Bottom");
    const bottomPixels = new Uint8ClampedArray(120 * 120 * 4);
    for (let i = 3; i < bottomPixels.length; i += 4) bottomPixels[i] = 255;
    setLayerPixels(bottom, bottomPixels, 120, 120);
    appendLayer(state, bottom);
    const top = createRasterLayer(120, 120, "Top");
    appendLayer(state, top);

    const cache = new RasterTileCache({ tileSize: 64 });
    const viewport: RasterRect = { x: 0, y: 0, width: 120, height: 120 };
    cache.update(state, viewport);

    const dabPixels = new Uint8ClampedArray(120 * 120 * 4);
    dabPixels[(10 * 120 + 10) * 4] = 200; dabPixels[(10 * 120 + 10) * 4 + 3] = 255;
    setLayerPixels(top, dabPixels, 120, 120, { bounds: { x: 10, y: 10, width: 1, height: 1 }, canShrink: false });
    cache.invalidate({ x: 10, y: 10, width: 1, height: 1 });
    const afterFirstEdit = cache.update(state, viewport);

    const secondDab = new Uint8ClampedArray(120 * 120 * 4);
    secondDab[(20 * 120 + 20) * 4 + 1] = 200; secondDab[(20 * 120 + 20) * 4 + 3] = 255;
    setLayerPixels(top, secondDab, 120, 120, { bounds: { x: 10, y: 10, width: 11, height: 11 }, canShrink: false });
    cache.invalidate({ x: 20, y: 20, width: 1, height: 1 });
    const afterSecondEdit = cache.update(state, viewport);

    const expected = compositeRasterRegion(state, viewport);
    const stitched = new Uint8ClampedArray(120 * 120 * 4);
    for (const tile of afterSecondEdit.visible) {
      for (let row = 0; row < tile.rect.height; row += 1) {
        const from = row * tile.rect.width * 4;
        stitched.set(tile.pixels.subarray(from, from + tile.rect.width * 4), ((tile.rect.y + row) * 120 + tile.rect.x) * 4);
      }
    }
    expect(stitched).toEqual(expected);
    expect(afterFirstEdit.repainted.length).toBeGreaterThan(0);
    expect(afterSecondEdit.repainted.length).toBeGreaterThan(0);
  });
});
