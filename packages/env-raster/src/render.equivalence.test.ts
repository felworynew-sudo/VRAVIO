import { describe, expect, it } from "vitest";
import { createAdjustmentLayer, createRasterDocument, createRasterGroup, createRasterLayer, createRasterLayerMask } from "./document";
import { setLayerPixels } from "./layer-bounds";
import { appendLayer } from "./layer-tree";
import { compositeRasterRegion } from "./render";
import { TileStore } from "./tile-store";
import type { RasterBlendMode, RasterDocumentState } from "./types";

/** The reduced composite's contract: each pixel is the premultiplied average of its step×step block of the full composite. */
function blockAverage(full: Uint8ClampedArray, width: number, height: number, step: number, column: number, row: number): number[] {
  let red = 0, green = 0, blue = 0, alpha = 0, count = 0;
  for (let y = row * step; y < Math.min(height, (row + 1) * step); y += 1) for (let x = column * step; x < Math.min(width, (column + 1) * step); x += 1) {
    const index = (y * width + x) * 4, a = full[index + 3]!;
    red += full[index]! * a; green += full[index + 1]! * a; blue += full[index + 2]! * a; alpha += a; count += 1;
  }
  const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(value)));
  return alpha > 0 ? [clamp(red / alpha), clamp(green / alpha), clamp(blue / alpha), clamp(alpha / count)] : [0, 0, 0, clamp(alpha / count)];
}

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

/** Builds a `size`×`size` pattern via `fillPattern` and wraps it as a fresh `TileStore`. */
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
      const pixels = new Uint8ClampedArray(size * size);
      for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 7) % 256;
      mask.tiles = TileStore.fromPixels(pixels, size, size, 1);
      mask.density = 0.8;
      state.layers[2]!.mask = mask;
    }), whole));

    // "Inverted" is no longer a flag (master-plan.md §19.2 — a lazy
    // `mask.inverted` the compositor applied only at render time let the
    // brush write raw, uninverted pixels, so painting white on an inverted
    // mask silently hid instead of revealing). Invert Mask now physically
    // rewrites the buffer, so this digest exercises that: same pattern as
    // `digests.mask` above, pixel values pre-inverted, expected to differ.
    digests.invertedMask = digest(compositeRasterRegion(scene((state) => {
      const mask = createRasterLayerMask(size, size);
      const pixels = new Uint8ClampedArray(size * size);
      for (let index = 0; index < pixels.length; index += 1) pixels[index] = 255 - ((index * 7) % 256);
      mask.tiles = TileStore.fromPixels(pixels, size, size, 1);
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

  it("renders Dissolve as deterministic binary coverage across tile boundaries", () => {
    const state = createRasterDocument(size, size);
    const basePixels = new Uint8ClampedArray(size * size * 4);
    for (let index = 0; index < basePixels.length; index += 4) { basePixels[index + 2] = 255; basePixels[index + 3] = 255; }
    state.layers[0]!.tiles = TileStore.fromPixels(basePixels, size, size);
    const top = createRasterLayer(size, size, "Dissolve");
    const topPixels = new Uint8ClampedArray(size * size * 4);
    for (let index = 0; index < topPixels.length; index += 4) { topPixels[index] = 255; topPixels[index + 3] = 255; }
    top.tiles = TileStore.fromPixels(topPixels, size, size);
    top.opacity = 0.5;
    top.blendMode = "dissolve";
    appendLayer(state, top);

    const full = compositeRasterRegion(state, whole);
    const part = compositeRasterRegion(state, { x: 5, y: 6, width: 9, height: 8 });
    let red = 0, blue = 0;
    for (let index = 0; index < full.length; index += 4) {
      if (full[index] === 255) red += 1;
      if (full[index + 2] === 255) blue += 1;
    }
    expect(red).toBeGreaterThan(0);
    expect(blue).toBeGreaterThan(0);
    for (let row = 0; row < 8; row += 1) {
      const from = ((6 + row) * size + 5) * 4;
      expect([...part.slice(row * 9 * 4, (row + 1) * 9 * 4)]).toEqual([...full.slice(from, from + 9 * 4)]);
    }
  });

  it("applies layer-mask feather non-destructively at composite time", () => {
    const state = createRasterDocument(11, 1);
    const top = createRasterLayer(11, 1, "Masked red");
    const topPixels = new Uint8ClampedArray(11 * 1 * 4);
    for (let index = 0; index < topPixels.length; index += 4) { topPixels[index] = 255; topPixels[index + 3] = 255; }
    top.tiles = TileStore.fromPixels(topPixels, 11, 1);
    const mask = createRasterLayerMask(11, 1, false);
    mask.tiles.writeLocalRegion({ x: 5, y: 0, width: 1, height: 1 }, new Uint8ClampedArray([255]));
    mask.feather = 2;
    top.mask = mask;
    appendLayer(state, top);

    const softened = compositeRasterRegion(state, { x: 0, y: 0, width: 11, height: 1 });
    expect(softened[5 * 4 + 3]!).toBeGreaterThan(0);
    expect(softened[4 * 4 + 3]!).toBeGreaterThan(0);

    mask.feather = 0;
    const sharp = compositeRasterRegion(state, { x: 0, y: 0, width: 11, height: 1 });
    expect(sharp[4 * 4 + 3]).toBe(0);
  });

  it("composites an isolated group before applying the group's opacity", () => {
    const build = (mode: "passThrough" | "isolated") => {
      const state = createRasterDocument(1, 1);
      state.layers = [];
      const group = createRasterGroup(1, 1, "Group");
      group.groupMode = mode;
      group.opacity = 0.5;
      appendLayer(state, group);
      const red = createRasterLayer(1, 1, "Red");
      red.parentId = group.id; red.tiles = TileStore.fromPixels(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1); red.opacity = 0.5;
      const blue = createRasterLayer(1, 1, "Blue");
      blue.parentId = group.id; blue.tiles = TileStore.fromPixels(new Uint8ClampedArray([0, 0, 255, 255]), 1, 1); blue.opacity = 0.5;
      state.layers.push(red, blue);
      return compositeRasterRegion(state, { x: 0, y: 0, width: 1, height: 1 });
    };
    const passThrough = build("passThrough"), isolated = build("isolated");
    expect([...isolated]).not.toEqual([...passThrough]);
    // Isolated: red/blue blend first (alpha .75), then the whole result gets
    // group opacity .5, yielding .375 rather than pass-through's .4375.
    expect(isolated[3]).toBeLessThan(passThrough[3]!);
  });

  it("applies an isolated group's blend mode and effects after its subtree", () => {
    const state = createRasterDocument(3, 1);
    state.layers = [];
    const backdrop = createRasterLayer(3, 1, "Backdrop");
    backdrop.tiles = TileStore.fromPixels(new Uint8ClampedArray([100, 200, 50, 255, 0, 0, 0, 0, 0, 0, 0, 0]), 3, 1);
    state.layers.push(backdrop);
    const group = createRasterGroup(3, 1, "Group");
    group.groupMode = "isolated";
    group.blendMode = "multiply";
    group.effects = { dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX: 1, offsetY: 0 } };
    appendLayer(state, group);
    const child = createRasterLayer(3, 1, "Child");
    child.parentId = group.id;
    child.tiles = TileStore.fromPixels(new Uint8ClampedArray([200, 100, 200, 255, 0, 0, 0, 0, 0, 0, 0, 0]), 3, 1);
    state.layers.push(child);

    const result = compositeRasterRegion(state, { x: 0, y: 0, width: 3, height: 1 });
    // The child is multiplied with the pre-existing backdrop at x=0.
    expect([...result.slice(0, 4)]).toEqual([78, 78, 39, 255]);
    // The group's shadow is drawn after its subtree, at x=1.
    expect(result[4 + 3]).toBe(255);
    expect([...result.slice(4, 7)]).toEqual([0, 0, 0]);
  });

  it("uses clipping coverage when an isolated group is clipped", () => {
    const state = createRasterDocument(2, 1);
    state.layers = [];
    const base = createRasterLayer(2, 1, "Base");
    base.tiles = TileStore.fromPixels(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]), 2, 1);
    state.layers.push(base);
    const group = createRasterGroup(2, 1, "Clipped group");
    group.groupMode = "isolated";
    group.clipping = true;
    appendLayer(state, group);
    const child = createRasterLayer(2, 1, "Blue child");
    child.parentId = group.id;
    child.tiles = TileStore.fromPixels(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 255, 255]), 2, 1);
    state.layers.push(child);

    const result = compositeRasterRegion(state, { x: 0, y: 0, width: 2, height: 1 });
    expect([...result.slice(4, 8)]).toEqual([0, 0, 0, 0]);
  });

  it("a reduced composite is the full composite averaged block by block", () => {
    // It used to take one pixel per step, which is what broke thin lines apart when zoomed out.
    const state = scene();
    const full = compositeRasterRegion(state, whole);
    const stepped = compositeRasterRegion(state, whole, { step: 3 });

    expect(stepped.length).toBe(8 * 8 * 4);
    for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
      const to = (row * 8 + column) * 4;
      const actual = [...stepped.slice(to, to + 4)], expected = blockAverage(full, size, size, 3, column, row);
      actual.forEach((value, channel) => expect(Math.abs(value - expected[channel]!)).toBeLessThanOrEqual(1));
    }
  });
});

describe("compositing a large region in pieces", () => {
  const LARGE = 600;

  const largeScene = (): RasterDocumentState => {
    const state = createRasterDocument(LARGE, LARGE);
    const basePixels = new Uint8ClampedArray(LARGE * LARGE * 4);
    fillPattern(basePixels, 3);
    state.layers[0]!.tiles = TileStore.fromPixels(basePixels, LARGE, LARGE);
    for (let index = 0; index < 4; index += 1) {
      const layer = createRasterLayer(LARGE, LARGE, `Patch ${index}`);
      // Content in one corner each, so most layers miss most pieces — the case
      // subdividing exists to exploit.
      const originX = (index % 2) * 300, originY = Math.floor(index / 2) * 300;
      const pixels = new Uint8ClampedArray(LARGE * LARGE * 4);
      for (let y = originY; y < originY + 260; y += 1) for (let x = originX; x < originX + 260; x += 1) {
        const at = (y * LARGE + x) * 4;
        pixels[at] = 40 * index; pixels[at + 1] = 200 - 30 * index; pixels[at + 2] = 90;
        pixels[at + 3] = 120 + index * 20;
      }
      layer.tiles = TileStore.fromPixels(pixels, LARGE, LARGE);
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

describe("an isolated group's own effect reaches across a tile boundary", () => {
  /**
   * Same donor pattern as "compositing a large region in pieces" just above (tile-by-tile against
   * the whole), aimed at a bug a live migration-review pass on §37.3 flagged: `render.ts`'s isolated
   * group branch used to composite its descendants for exactly the requested tile and nothing wider,
   * then run the group's own effect (Outer Glow, Drop Shadow, …) on that already-cropped surface —
   * so a shape that straddles a 256px tile boundary got a real, opaque black edge at x=256 instead
   * of its neighbour's pixels, and an Outer Glow near that edge either stopped dead or bled into
   * fabricated transparency. `requiredSourceRegion`-driven padding (this file's own §37.3 item 2
   * fix for ordinary layer effects) fixes the same class of bug here, scoped to just the group.
   */
  function crossingBoundaryScene(width: number, height: number): RasterDocumentState {
    const state = createRasterDocument(width, height);
    state.layers = [];
    const group = createRasterGroup(width, height, "Glow group");
    group.groupMode = "isolated";
    group.effects = { outerGlow: { enabled: true, color: "#ffffff", opacity: 1, radius: 20 } };
    appendLayer(state, group);
    const child = createRasterLayer(width, height, "Child");
    child.parentId = group.id;
    // A solid rectangle straddling x=256 — the exact tile seam a 256px `RasterTileCache` produces.
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 240; x < Math.min(width, 280); x += 1) {
      const at = (y * width + x) * 4;
      pixels[at] = 200; pixels[at + 1] = 50; pixels[at + 2] = 50; pixels[at + 3] = 255;
    }
    setLayerPixels(child, pixels, width, height);
    state.layers.push(child);
    return state;
  }

  it("a tile-by-tile composite matches the whole-document composite across the boundary", () => {
    const WIDTH = 320, HEIGHT = 32;
    const state = crossingBoundaryScene(WIDTH, HEIGHT);
    const whole = compositeRasterRegion(state, { x: 0, y: 0, width: WIDTH, height: HEIGHT });

    for (let left = 0; left < WIDTH; left += 256) {
      const width = Math.min(256, WIDTH - left);
      const tile = compositeRasterRegion(state, { x: left, y: 0, width, height: HEIGHT });
      for (let row = 0; row < HEIGHT; row += 1) {
        const from = (row * WIDTH + left) * 4;
        expect([...tile.slice(row * width * 4, (row + 1) * width * 4)], `row ${row}`).toEqual([...whole.slice(from, from + width * 4)]);
      }
    }
  });

  it("a tile with none of the shape's own pixels still shows the glow bleeding in from its neighbour", () => {
    // A tile entirely to the right of the child's own footprint (child: x in [240,280)) but still
    // within the glow's 20px reach (x in [280,300)) has nothing of its own to composite there — any
    // glow it shows can only have come from reading the child across the tile boundary at x=256.
    const WIDTH = 320, HEIGHT = 4;
    const state = crossingBoundaryScene(WIDTH, HEIGHT);
    const farRightTile = compositeRasterRegion(state, { x: 288, y: 0, width: 32, height: HEIGHT });
    const localX = 290 - 288; // document x=290: 10px right of the child's edge at x=280, inside the 20px glow.
    expect(farRightTile[localX * 4 + 3]).toBeGreaterThan(0);
  });
});

describe("a layer is read with its own stride", () => {
  it("draws the same picture whether a layer is trimmed or canvas-sized", () => {
    const trimmed = createRasterDocument(48, 48);
    const canvasSized = createRasterDocument(48, 48);
    for (const state of [trimmed, canvasSized]) {
      const layer = createRasterLayer(48, 48, "Block");
      const pixels = new Uint8ClampedArray(48 * 48 * 4);
      for (let y = 12; y < 30; y += 1) for (let x = 8; x < 26; x += 1) {
        const at = (y * 48 + x) * 4;
        pixels[at] = 220; pixels[at + 1] = 60; pixels[at + 2] = 90; pixels[at + 3] = 255;
      }
      if (state === trimmed) setLayerPixels(layer, pixels, 48, 48);
      else layer.tiles = TileStore.fromPixels(pixels, 48, 48);
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
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
    setLayerPixels(layer, pixels, 32, 32);
    appendLayer(state, layer);

    // Whatever a caller substitutes, the two have to describe the same buffer.
    for (const item of state.layers) {
      expect(item.tiles.width * item.tiles.height * 4).toBe(item.bounds.width * item.bounds.height * 4);
      expect(item.width).toBe(item.bounds.width);
      expect(item.height).toBe(item.bounds.height);
    }
  });
});
