import { describe, expect, it } from "vitest";
import { createAdjustmentLayer, createRasterDocument, createRasterLayer, createRasterLayerMask } from "./document";
import { setLayerPixels } from "./layer-bounds";
import { appendLayer } from "./layer-tree";
import { compositeRasterRegion } from "./render";
import type { RasterBlendMode, RasterDocumentState } from "./types";

const allModes: RasterBlendMode[] = [
  "normal", "dissolve", "darken", "multiply", "colorBurn", "linearBurn", "darkerColor",
  "lighten", "screen", "colorDodge", "linearDodge", "lighterColor", "overlay", "softLight",
  "hardLight", "vividLight", "linearLight", "pinLight", "hardMix", "difference", "exclusion",
  "subtract", "divide", "hue", "saturation", "color", "luminosity",
];

const size = 24;

/**
 * Deterministic pixels spanning the awkward parts of the domain: fully opaque,
 * fully transparent, and every partial alpha, with channel values that hit 0,
 * 255 and the midpoint where the blend formulas change branch.
 */
function fillPattern(pixels: Uint8ClampedArray, seed: number): void {
  let state = seed;
  const next = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state; };
  for (let index = 0; index < pixels.length; index += 4) {
    const pick = next() % 8;
    pixels[index] = pick === 0 ? 0 : pick === 1 ? 255 : pick === 2 ? 128 : next() % 256;
    pixels[index + 1] = pick === 3 ? 0 : pick === 4 ? 255 : next() % 256;
    pixels[index + 2] = pick === 5 ? 127 : next() % 256;
    pixels[index + 3] = pick === 6 ? 0 : pick === 7 ? 255 : next() % 256;
  }
}

function scene(mutate?: (state: RasterDocumentState) => void): RasterDocumentState {
  const state = createRasterDocument(size, size);
  fillPattern(state.layers[0]!.pixels, 7);
  const middle = createRasterLayer(size, size, "Middle");
  fillPattern(middle.pixels, 31);
  middle.opacity = 0.75;
  appendLayer(state, middle);
  const top = createRasterLayer(size, size, "Top");
  fillPattern(top.pixels, 97);
  appendLayer(state, top);
  mutate?.(state);
  return state;
}

const digest = (pixels: Uint8ClampedArray): string => {
  let hash = 2166136261;
  for (const value of pixels) { hash ^= value; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16);
};

const whole = { x: 0, y: 0, width: size, height: size };

/**
 * Locks the composited output down to the byte.
 *
 * The compositor is the one piece every tool draws through, so a change in its
 * inner loop that shifts a channel by one is both invisible in review and
 * visible in every document. These digests are the contract a rewrite has to
 * reproduce; they are expected to change only when the intended picture does.
 */
describe("composite output is stable", () => {
  it("matches the recorded digest for every blend mode", () => {
    const digests: Record<string, string> = {};
    for (const blendMode of allModes) {
      const state = scene((current) => { current.layers[2]!.blendMode = blendMode; });
      digests[blendMode] = digest(compositeRasterRegion(state, whole));
    }
    expect(digests).toMatchSnapshot();
  });

  it("matches the recorded digest for masks, clipping and adjustments", () => {
    const digests: Record<string, string> = {};

    digests.mask = digest(compositeRasterRegion(scene((state) => {
      const mask = createRasterLayerMask(size, size);
      for (let index = 0; index < mask.pixels.length; index += 1) mask.pixels[index] = (index * 7) % 256;
      mask.density = 0.8;
      state.layers[2]!.mask = mask;
    }), whole));

    digests.invertedMask = digest(compositeRasterRegion(scene((state) => {
      const mask = createRasterLayerMask(size, size);
      for (let index = 0; index < mask.pixels.length; index += 1) mask.pixels[index] = (index * 7) % 256;
      mask.inverted = true;
      state.layers[2]!.mask = mask;
    }), whole));

    digests.clipping = digest(compositeRasterRegion(scene((state) => {
      state.layers[2]!.clipping = true;
      state.layers[2]!.blendMode = "multiply";
    }), whole));

    digests.fillOpacity = digest(compositeRasterRegion(scene((state) => {
      state.layers[2]!.fillOpacity = 0.4;
      state.layers[2]!.opacity = 0.6;
    }), whole));

    digests.adjustment = digest(compositeRasterRegion(scene((state) => {
      const layer = createAdjustmentLayer(size, size, "levels", "Levels");
      layer.adjustment = { kind: "levels", blackInput: 20, gamma: 1.4, whiteInput: 230, blackOutput: 10, whiteOutput: 245 };
      appendLayer(state, layer);
    }), whole));

    digests.clippedAdjustment = digest(compositeRasterRegion(scene((state) => {
      const layer = createAdjustmentLayer(size, size, "invert", "Invert");
      layer.clipping = true;
      appendLayer(state, layer);
    }), whole));

    digests.hiddenLayer = digest(compositeRasterRegion(scene((state) => {
      state.layers[1]!.visible = false;
    }), whole));

    expect(digests).toMatchSnapshot();
  });

  it("a sub-region matches the same pixels of the full composite", () => {
    const state = scene((current) => { current.layers[2]!.blendMode = "overlay"; });
    const full = compositeRasterRegion(state, whole);
    const part = compositeRasterRegion(state, { x: 6, y: 5, width: 8, height: 7 });

    // Tiles are composited independently, so a region must not depend on what
    // surrounds it — otherwise the cache produces seams.
    for (let row = 0; row < 7; row += 1) {
      const from = ((5 + row) * size + 6) * 4;
      expect([...part.slice(row * 8 * 4, (row + 1) * 8 * 4)]).toEqual([...full.slice(from, from + 8 * 4)]);
    }
  });

  it("subsampling picks the same pixels the full composite has", () => {
    const state = scene();
    const full = compositeRasterRegion(state, whole);
    const stepped = compositeRasterRegion(state, whole, { step: 3 });

    expect(stepped.length).toBe(8 * 8 * 4);
    for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
      const from = ((row * 3) * size + column * 3) * 4, to = (row * 8 + column) * 4;
      expect([...stepped.slice(to, to + 4)]).toEqual([...full.slice(from, from + 4)]);
    }
  });
});

describe("compositing a large region in pieces", () => {
  const LARGE = 600;

  const largeScene = (): RasterDocumentState => {
    const state = createRasterDocument(LARGE, LARGE);
    fillPattern(state.layers[0]!.pixels, 3);
    for (let index = 0; index < 4; index += 1) {
      const layer = createRasterLayer(LARGE, LARGE, `Patch ${index}`);
      // Content in one corner each, so most layers miss most pieces — the case
      // subdividing exists to exploit.
      const originX = (index % 2) * 300, originY = Math.floor(index / 2) * 300;
      for (let y = originY; y < originY + 260; y += 1) for (let x = originX; x < originX + 260; x += 1) {
        const at = (y * LARGE + x) * 4;
        layer.pixels[at] = 40 * index; layer.pixels[at + 1] = 200 - 30 * index; layer.pixels[at + 2] = 90;
        layer.pixels[at + 3] = 120 + index * 20;
      }
      layer.blendMode = (["multiply", "screen", "overlay", "normal"] as const)[index]!;
      layer.opacity = 0.8;
      appendLayer(state, layer);
    }
    return state;
  };

  it("matches the same pixels composited tile by tile", () => {
    const state = largeScene();
    const whole = compositeRasterRegion(state, { x: 0, y: 0, width: LARGE, height: LARGE });

    // Tiles go through the direct path, since each is well under the threshold.
    for (let top = 0; top < LARGE; top += 256) {
      for (let left = 0; left < LARGE; left += 256) {
        const width = Math.min(256, LARGE - left), height = Math.min(256, LARGE - top);
        const tile = compositeRasterRegion(state, { x: left, y: top, width, height });
        for (let row = 0; row < height; row += 1) {
          const from = ((top + row) * LARGE + left) * 4;
          expect([...tile.slice(row * width * 4, (row + 1) * width * 4)]).toEqual([...whole.slice(from, from + width * 4)]);
        }
      }
    }
  });

  it("returns a buffer of the size it was asked for", () => {
    const state = largeScene();

    // An off-grid region has to come back at its own size, not rounded to the
    // subdivision.
    expect(compositeRasterRegion(state, { x: 7, y: 9, width: 590, height: 580 }).length).toBe(590 * 580 * 4);
  });
});

describe("a layer is read with its own stride", () => {
  it("draws the same picture whether a layer is trimmed or canvas-sized", () => {
    const trimmed = createRasterDocument(48, 48);
    const canvasSized = createRasterDocument(48, 48);
    for (const state of [trimmed, canvasSized]) {
      const layer = createRasterLayer(48, 48, "Block");
      for (let y = 12; y < 30; y += 1) for (let x = 8; x < 26; x += 1) {
        const at = (y * 48 + x) * 4;
        layer.pixels[at] = 220; layer.pixels[at + 1] = 60; layer.pixels[at + 2] = 90; layer.pixels[at + 3] = 255;
      }
      if (state === trimmed) setLayerPixels(layer, layer.pixels, 48, 48);
      appendLayer(state, layer);
    }

    // The regression this exists for: a canvas-sized buffer left on a layer
    // whose bounds still describe a smaller rectangle is read a row at a time
    // from the wrong offset, and the picture comes out as diagonal streaks.
    expect([...compositeRasterRegion(trimmed, { x: 0, y: 0, width: 48, height: 48 })])
      .toEqual([...compositeRasterRegion(canvasSized, { x: 0, y: 0, width: 48, height: 48 })]);
  });

  it("keeps bounds and buffer in step when a working buffer is swapped in", () => {
    const state = createRasterDocument(32, 32);
    const layer = createRasterLayer(32, 32, "Block");
    for (let index = 3; index < layer.pixels.length; index += 4) layer.pixels[index] = 255;
    setLayerPixels(layer, layer.pixels, 32, 32);
    appendLayer(state, layer);

    // Whatever a caller substitutes, the two have to describe the same buffer.
    for (const item of state.layers) {
      expect(item.pixels.length).toBe(item.bounds.width * item.bounds.height * 4);
      expect(item.width).toBe(item.bounds.width);
      expect(item.height).toBe(item.bounds.height);
    }
  });
});
