import { describe, expect, it } from "vitest";
import { createAdjustmentLayer, createRasterDocument, createRasterGroup, createRasterLayer, createRasterLayerMask } from "./document";
import { appendLayer } from "./layer-tree";
import { compositeRasterRegion, isSimpleLayerStack, blendSimpleLayerStack } from "./render";
import { layerDocumentPixels } from "./layer-bounds";
import { TileStore } from "./tile-store";
import type { RasterBlendMode, RasterDocumentState } from "./types";

/**
 * docs/master-plan.md §37.3 item 4's Worker-portable fast path: `blendSimpleLayerStack` must
 * produce byte-identical output to the full `compositeRasterRegion` for exactly the stacks
 * `isSimpleLayerStack` calls safe — the same "sever byte-for-byte against the full recompute"
 * discipline §37.8/§37.9 already used for the checkpoint cache, applied to this fast path instead
 * of trusting the extraction by inspection alone.
 */

const allModes: RasterBlendMode[] = [
  "normal", "dissolve", "darken", "multiply", "colorBurn", "linearBurn", "darkerColor",
  "lighten", "screen", "colorDodge", "linearDodge", "lighterColor", "overlay", "softLight",
  "hardLight", "vividLight", "linearLight", "pinLight", "hardMix", "difference", "exclusion",
  "subtract", "divide", "hue", "saturation", "color", "luminosity",
];

const size = 24;
const whole = { x: 0, y: 0, width: size, height: size };

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

function patternTiles(seed: number): TileStore {
  const pixels = new Uint8ClampedArray(size * size * 4);
  fillPattern(pixels, seed);
  return TileStore.fromPixels(pixels, size, size);
}

function scene(mutate?: (state: RasterDocumentState) => void): RasterDocumentState {
  const state = createRasterDocument(size, size);
  state.layers[0]!.tiles = patternTiles(7);
  const middle = createRasterLayer(size, size, "Middle");
  middle.tiles = patternTiles(31);
  middle.opacity = 0.75;
  appendLayer(state, middle);
  const top = createRasterLayer(size, size, "Top");
  top.tiles = patternTiles(97);
  appendLayer(state, top);
  mutate?.(state);
  return state;
}

/** Runs the fast path exactly as a Worker-side caller would: materialise each layer's
 *  document-space pixels on the "main thread" side, then blend the already-flat buffers. */
function runFastPath(state: RasterDocumentState): Uint8ClampedArray {
  const layers = state.layers.map((layer) => ({
    pixels: layerDocumentPixels(layer, state.width, state.height, whole),
    opacity: layer.opacity * (layer.fillOpacity ?? 1),
    blendMode: layer.blendMode,
  }));
  return blendSimpleLayerStack(size, size, layers, whole.x, whole.y);
}

describe("isSimpleLayerStack", () => {
  it("is true for a stack of plain, unmasked, unclipped, effect-free pixel layers", () => {
    expect(isSimpleLayerStack(scene())).toBe(true);
  });

  it("is true regardless of blend mode — blend mode alone doesn't disqualify a stack", () => {
    for (const blendMode of allModes) {
      expect(isSimpleLayerStack(scene((state) => { state.layers[2]!.blendMode = blendMode; })), blendMode).toBe(true);
    }
  });

  it("ignores an invisible or fully-transparent layer's own mask/clip/effects", () => {
    const state = scene((current) => {
      current.layers[2]!.visible = false;
      current.layers[2]!.clipping = true;
      const mask = createRasterLayerMask(size, size);
      current.layers[2]!.mask = mask;
      current.layers[2]!.mask.enabled = true;
    });
    expect(isSimpleLayerStack(state)).toBe(true);
  });

  it("is false when any layer has an enabled mask", () => {
    const state = scene((current) => {
      const mask = createRasterLayerMask(size, size);
      mask.tiles = TileStore.fromPixels(new Uint8ClampedArray(size * size).fill(200), size, size, 1);
      current.layers[2]!.mask = mask;
    });
    expect(isSimpleLayerStack(state)).toBe(false);
  });

  it("is false when any layer clips to the one below it", () => {
    const state = scene((current) => { current.layers[2]!.clipping = true; });
    expect(isSimpleLayerStack(state)).toBe(false);
  });

  it("is false when any layer has an enabled effect", () => {
    const state = scene((current) => { current.layers[2]!.effects = { glass: { enabled: true, blur: 4, tintOpacity: 0.5 } } as never; });
    expect(isSimpleLayerStack(state)).toBe(false);
  });

  it("is false when the stack contains a group", () => {
    const state = scene();
    const group = createRasterGroup(size, size, "Group");
    appendLayer(state, group);
    expect(isSimpleLayerStack(state)).toBe(false);
  });

  it("is false when the stack contains an adjustment layer", () => {
    const state = scene();
    const adjustment = createAdjustmentLayer(size, size, "invert");
    appendLayer(state, adjustment);
    expect(isSimpleLayerStack(state)).toBe(false);
  });
});

describe("blendSimpleLayerStack matches compositeRasterRegion byte-for-byte", () => {
  it("for every blend mode on the top layer", () => {
    for (const blendMode of allModes) {
      const state = scene((current) => { current.layers[2]!.blendMode = blendMode; });
      expect([...runFastPath(state)], blendMode).toEqual([...compositeRasterRegion(state, whole)]);
    }
  });

  it("for varied opacity and fill opacity", () => {
    const state = scene((current) => { current.layers[1]!.opacity = 0.4; current.layers[2]!.fillOpacity = 0.6; });
    expect([...runFastPath(state)]).toEqual([...compositeRasterRegion(state, whole)]);
  });

  it("for a fully transparent top layer (alpha 0 everywhere)", () => {
    const state = scene((current) => { current.layers[2]!.tiles = TileStore.fromPixels(new Uint8ClampedArray(size * size * 4), size, size); });
    expect([...runFastPath(state)]).toEqual([...compositeRasterRegion(state, whole)]);
  });

  it("for a fully opaque normal top layer (the opaqueNormal fast-replace branch)", () => {
    const opaque = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < opaque.length; i += 4) { opaque[i] = 10; opaque[i + 1] = 20; opaque[i + 2] = 30; opaque[i + 3] = 255; }
    const state = scene((current) => { current.layers[2]!.tiles = TileStore.fromPixels(opaque, size, size); current.layers[2]!.blendMode = "normal"; current.layers[2]!.opacity = 1; });
    expect([...runFastPath(state)]).toEqual([...compositeRasterRegion(state, whole)]);
  });
});
