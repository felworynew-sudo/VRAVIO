import { describe, expect, it } from "vitest";
import { appendLayer, compositeRasterDocument, createRasterDocument, createRasterLayer, setLayerPixels, type RasterBlendMode, type RasterDocumentState } from "./index";

/**
 * Photoshop's clipping groups: the base layer's blend mode governs the whole group.
 *
 * The owner's own report — a layer clipped to a Soft Light base arrived as if it were Normal,
 * because the compositor only cut the clipped layer's alpha down to the base's and then blended
 * it, with its own mode, straight against everything underneath. Photoshop ("Blend Clipped Layers
 * as Group", on by default) composites the base and its clipped layers in isolation and lays the
 * result down with the *base's* mode and opacity.
 *
 * The assertions are equivalences rather than expected numbers, so that no blend-mode arithmetic
 * is copied into the test to drift away from the engine's own: a Normal layer clipped to a Soft
 * Light base must look exactly like a single Soft Light layer carrying the clipped layer's
 * colours over the base's shape.
 */
const W = 8, H = 8;

function fill(r: number, g: number, b: number, a = 255, region?: { x0: number; x1: number }): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    if (region && (x < region.x0 || x >= region.x1)) continue;
    const index = (y * W + x) * 4;
    pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = a;
  }
  return pixels;
}

/** A backdrop with some variety, so a blend mode has something to actually do. */
function backdrop(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const index = (y * W + x) * 4;
    pixels[index] = 30 + x * 25; pixels[index + 1] = 90; pixels[index + 2] = 200 - y * 20; pixels[index + 3] = 255;
  }
  return pixels;
}

function document(...layers: { pixels: Uint8ClampedArray; blendMode?: RasterBlendMode; opacity?: number; clipping?: boolean }[]): RasterDocumentState {
  const state = createRasterDocument(W, H);
  state.layers = [];
  layers.forEach((entry, index) => {
    const layer = createRasterLayer(W, H, `layer ${index}`);
    setLayerPixels(layer, entry.pixels, W, H, null, { keepOutsideDocument: true });
    layer.blendMode = entry.blendMode ?? "normal";
    layer.opacity = entry.opacity ?? 1;
    layer.clipping = entry.clipping ?? false;
    appendLayer(state, layer);
    state.activeLayerId = layer.id;
  });
  return state;
}

const composite = (state: RasterDocumentState) => compositeRasterDocument(state);

function expectSame(left: Uint8ClampedArray, right: Uint8ClampedArray, tolerance = 1): void {
  let worst = 0, at = -1;
  for (let index = 0; index < left.length; index += 1) {
    const difference = Math.abs(left[index]! - right[index]!);
    if (difference > worst) { worst = difference; at = index; }
  }
  expect(worst, `largest difference ${worst} at byte ${at}`).toBeLessThanOrEqual(tolerance);
}

describe("a clipping group blends with its base layer's mode", () => {
  const base = fill(200, 60, 40, 255, { x0: 2, x1: 6 });   // the shape everything is clipped to
  const clipped = fill(40, 220, 120);                      // covers the whole canvas, Normal

  it("a Normal layer clipped to a Soft Light base arrives through Soft Light", () => {
    const clipping = composite(document(
      { pixels: backdrop() },
      { pixels: base, blendMode: "softLight" },
      { pixels: clipped, clipping: true },
    ));
    // The same picture, said without any clipping at all: one Soft Light layer whose colours are
    // the clipped layer's and whose shape is the base's.
    const equivalent = composite(document(
      { pixels: backdrop() },
      { pixels: fill(40, 220, 120, 255, { x0: 2, x1: 6 }), blendMode: "softLight" },
    ));
    expectSame(clipping, equivalent);

    // And it is genuinely not what Normal would have produced — the bug being fixed.
    const asNormal = composite(document(
      { pixels: backdrop() },
      { pixels: fill(40, 220, 120, 255, { x0: 2, x1: 6 }) },
    ));
    let worst = 0;
    for (let index = 0; index < clipping.length; index += 1) worst = Math.max(worst, Math.abs(clipping[index]! - asNormal[index]!));
    expect(worst).toBeGreaterThan(8);
  });

  it("the clipped layer's own mode applies against the base's colour, inside the group", () => {
    const clipping = composite(document(
      { pixels: backdrop() },
      { pixels: base, blendMode: "multiply" },
      { pixels: clipped, blendMode: "screen", clipping: true },
    ));
    // Screen over the base's colour, then the whole thing down through Multiply.
    const screened = new Uint8ClampedArray(W * H * 4);
    for (let index = 0; index < screened.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const s = clipped[index + channel]! / 255, d = base[index + channel]! / 255;
        screened[index + channel] = (1 - (1 - s) * (1 - d)) * 255;
      }
      screened[index + 3] = base[index + 3]!;
    }
    const equivalent = composite(document({ pixels: backdrop() }, { pixels: screened, blendMode: "multiply" }));
    expectSame(clipping, equivalent);
  });

  it("the base's opacity fades the whole group, not just the base", () => {
    const half = composite(document(
      { pixels: backdrop() },
      { pixels: base, blendMode: "normal", opacity: .5 },
      { pixels: clipped, clipping: true },
    ));
    // One half-opaque Normal layer carrying the clipped colours over the base's shape.
    const equivalent = composite(document(
      { pixels: backdrop() },
      { pixels: fill(40, 220, 120, 255, { x0: 2, x1: 6 }), opacity: .5 },
    ));
    expectSame(half, equivalent);
  });

  it("nothing escapes the base's shape, and a hidden base takes the group with it", () => {
    const plain = composite(document({ pixels: backdrop() }));
    const clipping = composite(document(
      { pixels: backdrop() },
      { pixels: base, blendMode: "softLight" },
      { pixels: clipped, clipping: true },
    ));
    // Outside the base's columns the backdrop is untouched.
    for (let y = 0; y < H; y += 1) for (const x of [0, 1, 6, 7]) {
      const index = (y * W + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) expect(clipping[index + channel]).toBe(plain[index + channel]);
    }

    const hiddenBase = document(
      { pixels: backdrop() },
      { pixels: base, blendMode: "softLight" },
      { pixels: clipped, clipping: true },
    );
    hiddenBase.layers[1]!.visible = false;
    expectSame(composite(hiddenBase), plain, 0);
  });

  it("two layers clipped to one base both stay inside it, in order", () => {
    const upper = fill(10, 10, 240, 255, { x0: 4, x1: 8 });
    const clipping = composite(document(
      { pixels: backdrop() },
      { pixels: base, blendMode: "softLight" },
      { pixels: clipped, clipping: true },
      { pixels: upper, clipping: true },
    ));
    // Inside the group: the clipped fill, with the upper layer painted over it where it covers.
    const inside = fill(40, 220, 120, 255, { x0: 2, x1: 6 });
    for (let y = 0; y < H; y += 1) for (let x = 4; x < 6; x += 1) {
      const index = (y * W + x) * 4;
      inside[index] = 10; inside[index + 1] = 10; inside[index + 2] = 240;
    }
    const equivalent = composite(document({ pixels: backdrop() }, { pixels: inside, blendMode: "softLight" }));
    expectSame(clipping, equivalent);
  });
});
