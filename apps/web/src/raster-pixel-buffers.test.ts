import { appendLayer, compositeRasterDocument, compositeRasterRegion, createRasterDocument, createRasterLayer, setLayerPixels } from "@vravio/env-raster";
import { describe, expect, it } from "vitest";
import { withActiveLayerPixels, withLayersPixels } from "./raster-pixel-buffers";

/**
 * `withActiveLayerPixels`/`withLayersPixels` are the fix for a real, shipping migration bug: they
 * used to hand the compositor a `RasterLayer`-shaped object with a phantom `pixels` field that
 * nothing reads any more (`RasterLayer` has had only `tiles` since docs/master-plan.md §37.6.3), so
 * every preview frame on any document that does not qualify for `canDirectRasterPreviewBlit`'s
 * single-layer fast path — i.e. essentially any real multi-layer document — silently composited the
 * layer's last *committed* tiles instead of the in-progress working buffer. A brush stroke was
 * invisible until release; a Skew/Distort/Warp frame read stale content. These tests exercise
 * exactly the multi-layer case the old bug needed to manifest, and hold the `region` fast path this
 * file added afterward (to avoid re-tiling the whole document every `pointermove`) to the exact same
 * result as the no-region path, frame by frame across a sequence — not just the last frame, the same
 * discipline `transform-drag-cache.test.ts` uses for the same reason.
 */

function twoLayerScene() {
  const state = createRasterDocument(40, 40);
  const base = state.layers[0]!;
  const basePixels = base.tiles.toPixels();
  for (let i = 0; i < basePixels.length; i += 4) { basePixels[i] = 10; basePixels[i + 1] = 20; basePixels[i + 2] = 30; basePixels[i + 3] = 255; }
  setLayerPixels(base, basePixels, 40, 40);
  const top = createRasterLayer(40, 40, "Top");
  const topPixels = top.tiles.toPixels();
  for (let i = 0; i < topPixels.length; i += 4) { topPixels[i] = 200; topPixels[i + 1] = 0; topPixels[i + 2] = 0; topPixels[i + 3] = 128; }
  setLayerPixels(top, topPixels, 40, 40);
  appendLayer(state, top);
  state.activeLayerId = base.id;
  return state;
}

function frames(width: number, height: number, seeds: readonly number[]): Uint8ClampedArray[] {
  return seeds.map((seed) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = (seed * 7 + i) % 256; pixels[i + 1] = (seed * 13 + i) % 256; pixels[i + 2] = (seed * 19 + i) % 256; pixels[i + 3] = 255;
    }
    return pixels;
  });
}

describe("withActiveLayerPixels reads the in-progress buffer, not the layer's last committed tiles", () => {
  it("a second, unrelated layer no longer masks the active layer's live preview (the exact migration bug)", () => {
    const state = twoLayerScene();
    const working = new Uint8ClampedArray(40 * 40 * 4);
    working.fill(255); // solid white working buffer — nothing like either layer's committed content
    const preview = withActiveLayerPixels(state, working);
    const composited = compositeRasterDocument(preview);
    // Every pixel must show the white working buffer blended under the semi-transparent red top
    // layer, not the base layer's committed dark-blue content the old `pixels`-field bug would
    // have left compositing against.
    expect(composited[0]).toBeGreaterThan(200); // red channel: white base + red*0.5 alpha over it, not 10 (committed)
  });

  it("region fast path matches the no-region path frame by frame, across a multi-layer document", () => {
    const state = twoLayerScene();
    const region = { x: 5, y: 5, width: 12, height: 10 };
    for (const pixels of frames(40, 40, [1, 2, 3, 4, 5])) {
      const withRegion = compositeRasterRegion(withActiveLayerPixels(state, pixels, region), region);
      const withoutRegion = compositeRasterRegion(withActiveLayerPixels(state, pixels), region);
      expect([...withRegion]).toEqual([...withoutRegion]);
    }
  });

  it("a later frame's small region leaves the rest of the cached preview at the previous frame's content", () => {
    const state = twoLayerScene();
    const [first, second] = frames(40, 40, [10, 20]) as [Uint8ClampedArray, Uint8ClampedArray];
    const fullRegion = { x: 0, y: 0, width: 40, height: 40 };
    withActiveLayerPixels(state, first, fullRegion); // seed the cache for this layer at pixelsRevision
    const smallRegion = { x: 0, y: 0, width: 4, height: 4 };
    const cached = withActiveLayerPixels(state, second, smallRegion);

    // Outside the touched rectangle, the composite must still show `first`'s content — proof the
    // small-region write is genuinely incremental (`clone()` + `writeRegion()`), not a disguised
    // full re-tile from `second` that happens to also match a full no-region call.
    const outside = { x: 10, y: 10, width: 4, height: 4 };
    expect([...compositeRasterRegion(cached, outside)]).toEqual([...compositeRasterRegion(withActiveLayerPixels(state, first, fullRegion), outside)]);

    // Inside it, the composite must show `second`'s content.
    expect([...compositeRasterRegion(cached, smallRegion)]).toEqual([...compositeRasterRegion(withActiveLayerPixels(state, second), smallRegion)]);
  });
});

describe("withLayersPixels's region fast path", () => {
  it("matches the no-region path frame by frame for a linked-layer drag", () => {
    const state = twoLayerScene();
    const topId = state.layers[1]!.id, baseId = state.layers[0]!.id;
    const region = { x: 2, y: 2, width: 15, height: 15 };
    const baseFrames = frames(40, 40, [1, 3, 5]), topFrames = frames(40, 40, [2, 4, 6]);
    for (let i = 0; i < baseFrames.length; i += 1) {
      const updates = new Map([[baseId, baseFrames[i]!], [topId, topFrames[i]!]]);
      const withRegion = compositeRasterRegion(withLayersPixels(state, updates, region), region);
      const withoutRegion = compositeRasterRegion(withLayersPixels(state, updates), region);
      expect([...withRegion]).toEqual([...withoutRegion]);
    }
  });
});
