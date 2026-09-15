import { describe, expect, it } from "vitest";
import { appendLayer, compositeRasterDocument, compositeRasterRegion, createRasterDocument, createRasterLayer, renderLayerEffects } from "./index";
import { layerPixelsView } from "./layer-bounds";
import { TileStore } from "./tile-store";
import type { RasterLayer, RasterLayerEffects } from "./types";

const W = 40, H = 40;

/** An opaque square in the middle of a transparent layer. */
function squareLayer(): RasterLayer {
  const layer = createRasterLayer(W, H, "Shape");
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let y = 12; y < 28; y += 1) for (let x = 12; x < 28; x += 1) {
    const index = (y * W + x) * 4;
    pixels[index] = 180; pixels[index + 1] = 120; pixels[index + 2] = 90; pixels[index + 3] = 255;
  }
  layer.tiles = TileStore.fromPixels(pixels, W, H);
  return layer;
}

const at = (pixels: Uint8ClampedArray, x: number, y: number) => {
  const index = (y * W + x) * 4;
  return { r: pixels[index]!, g: pixels[index + 1]!, b: pixels[index + 2]!, a: pixels[index + 3]! };
};

const render = (effects: RasterLayerEffects, layer = squareLayer()) => {
  layer.effects = effects;
  return renderLayerEffects(layer, W, H);
};

describe("layer effects", () => {
  it("returns the source buffer itself when nothing is enabled", () => {
    const layer = squareLayer();

    // Not merely equal: allocating a copy per layer per tile is the cost this
    // shortcut exists to avoid.
    expect(renderLayerEffects(layer, W, H)).toBe(layerPixelsView(layer));
    expect(render({ dropShadow: { enabled: false, color: "#000000", opacity: 1, offsetX: 4, offsetY: 4 } }, layer)).toBe(layerPixelsView(layer));
  });

  it("never writes into the source buffer", () => {
    const layer = squareLayer();
    const before = layer.tiles.toPixels();

    render({ dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX: 4, offsetY: 4 } }, layer);

    expect([...layer.tiles.toPixels()]).toEqual([...before]);
  });

  it("casts a drop shadow on the offset side and leaves the other side clear", () => {
    const pixels = render({ dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX: 4, offsetY: 4 } });

    // Four pixels past the bottom-right corner is inside the shadow; the same
    // distance past the top-left is outside it.
    expect(at(pixels, 30, 30).a).toBeGreaterThan(0);
    expect(at(pixels, 10, 10).a).toBe(0);
  });

  it("grows an outer glow to its radius and no further", () => {
    const radius = 6;
    const pixels = render({ outerGlow: { enabled: true, color: "#ffffff", opacity: 1, radius } });

    // The square spans 12..27, so x = 11 is one pixel outside its left edge.
    expect(at(pixels, 12 - radius, 20).a).toBeGreaterThan(0);
    expect(at(pixels, 12 - radius - 2, 20).a).toBe(0);
  });

  it("keeps an inner glow inside the shape", () => {
    const pixels = render({ innerGlow: { enabled: true, color: "#ffffff", opacity: 1, radius: 4 } });

    // Bright at the shape's own edge, untouched outside it, and the middle of a
    // sixteen-pixel square is further than four from any edge.
    expect(at(pixels, 13, 20).r).toBeGreaterThan(200);
    expect(at(pixels, 10, 20).a).toBe(0);
    expect(at(pixels, 20, 20).r).toBeLessThan(200);
  });

  it("runs a gradient overlay along its angle", () => {
    const horizontal = render({ gradientOverlay: { enabled: true, from: "#000000", to: "#ffffff", opacity: 1, angle: 0 } });
    const vertical = render({ gradientOverlay: { enabled: true, from: "#000000", to: "#ffffff", opacity: 1, angle: 90 } });

    expect(at(horizontal, 26, 20).r).toBeGreaterThan(at(horizontal, 13, 20).r);
    expect(at(horizontal, 20, 26).r).toBe(at(horizontal, 20, 13).r);
    expect(at(vertical, 20, 26).r).toBeGreaterThan(at(vertical, 20, 13).r);
  });

  it("leaves transparent pixels transparent under an overlay", () => {
    const pixels = render({ gradientOverlay: { enabled: true, from: "#ff0000", to: "#00ff00", opacity: 1, angle: 0 } });

    expect(at(pixels, 2, 2).a).toBe(0);
  });

  it("scales a shadow with its opacity", () => {
    const full = render({ dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX: 4, offsetY: 4 } });
    const faint = render({ dropShadow: { enabled: true, color: "#000000", opacity: 0.25, offsetX: 4, offsetY: 4 } });

    expect(at(faint, 30, 30).a).toBeLessThan(at(full, 30, 30).a);
    expect(at(faint, 30, 30).a).toBeGreaterThan(0);
  });
});

describe("layer effects cache", () => {
  const shadow = (offsetX: number): RasterLayerEffects => ({ dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX, offsetY: 4 } });

  it("hands back the same surface for a repeated request", () => {
    const layer = squareLayer();
    layer.effects = shadow(4);

    // Tiles ask for the whole layer one after another; rendering it again per
    // tile is what made an effect unusable on a large document.
    expect(renderLayerEffects(layer, W, H)).toBe(renderLayerEffects(layer, W, H));
  });

  it("re-renders when the style changes", () => {
    const layer = squareLayer();
    layer.effects = shadow(4);
    const first = renderLayerEffects(layer, W, H);

    layer.effects = shadow(-4);
    const second = renderLayerEffects(layer, W, H);

    expect(second).not.toBe(first);
    expect(at(second, 10, 30).a).toBeGreaterThan(0);
    expect(at(second, 30, 30).a).toBe(0);
  });

  it("re-renders when the pixels are replaced", () => {
    const layer = squareLayer();
    layer.effects = shadow(4);
    const first = renderLayerEffects(layer, W, H);

    const movedPixels = new Uint8ClampedArray(W * H * 4);
    for (let y = 2; y < 8; y += 1) for (let x = 2; x < 8; x += 1) {
      const index = (y * W + x) * 4;
      movedPixels[index + 3] = 255;
    }
    // The raw reassignment setLayerPixels does in production, including the
    // revision bump renderLayerEffects's cache now keys on instead of pixels
    // identity (docs/master-plan.md §37.6.2).
    layer.tiles = TileStore.fromPixels(movedPixels, W, H);
    layer.pixelsRevision += 1;
    const second = renderLayerEffects(layer, W, H);

    expect(second).not.toBe(first);
    expect(at(second, 30, 30).a).toBe(0);
    expect(at(second, 10, 10).a).toBeGreaterThan(0);
  });

  it("re-renders at a different size", () => {
    const layer = squareLayer();
    layer.effects = shadow(4);
    const first = renderLayerEffects(layer, W, H);

    expect(renderLayerEffects(layer, W / 2, H * 2)).not.toBe(first);
  });
});

/**
 * The owner's report: turning on almost any layer style makes the layer come
 * out distorted in the viewport.
 *
 * Every case above builds its layer with `createRasterLayer(W, H)`, whose
 * bounds are the whole document — so every one of them reads a buffer whose
 * stride happens to equal the document width. Real layers do not look like
 * that: pixels are stored in the layer's own bounds (the optimisation that took
 * 21 layers from 166 MB to 3.1 MB), so a trimmed layer's buffer has a stride of
 * its own, and reading it at the document's stride shears the picture.
 */
describe("layer effects on a layer stored in its own bounds", () => {
  /** The same square, but trimmed the way `setLayerPixels` leaves a real layer:
   * a 16x16 buffer with bounds at (12, 12), not a 40x40 one. */
  function trimmedSquareLayer(): RasterLayer {
    const layer = createRasterLayer(W, H, "Shape");
    const size = 16;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let index = 0; index < size * size; index += 1) {
      pixels[index * 4] = 180; pixels[index * 4 + 1] = 120; pixels[index * 4 + 2] = 90; pixels[index * 4 + 3] = 255;
    }
    layer.tiles = TileStore.fromPixels(pixels, size, size);
    layer.bounds = { x: 12, y: 12, width: size, height: size };
    layer.width = size; layer.height = size;
    return layer;
  }

  it("renders a surface the size of the document, not of the layer's buffer", () => {
    const layer = trimmedSquareLayer();
    layer.effects = { dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX: 4, offsetY: 4 } };
    // The compositor reads this surface at document size and document stride
    // (render.ts's `wholeCanvas` branch), so anything shorter is read past its
    // end for most of the canvas.
    expect(renderLayerEffects(layer, W, H).length).toBe(W * H * 4);
  });

  it("puts the layer's own pixels where the layer actually is", () => {
    const layer = trimmedSquareLayer();
    layer.effects = { dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX: 4, offsetY: 4 } };
    const rendered = renderLayerEffects(layer, W, H);

    // The square occupies (12,12)-(27,27) in document space and nothing else
    // does; the shadow adds an opaque skirt down and right of it. What must not
    // happen is the square landing somewhere else, which is what reading a
    // 16-wide buffer at a stride of 40 produces.
    expect(at(rendered, 20, 20)).toEqual({ r: 180, g: 120, b: 90, a: 255 });
    expect(at(rendered, 12, 12).a).toBe(255);
    expect(at(rendered, 27, 27).a).toBe(255);
    // Above and left of the square there is neither shape nor shadow.
    expect(at(rendered, 4, 4).a).toBe(0);
    expect(at(rendered, 35, 8).a).toBe(0);
    // The shadow is offset by (4,4), so just past the bottom-right corner it is
    // there and it is black.
    expect(at(rendered, 30, 30)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });
});

describe("Glass backdrop effect", () => {
  function backdropDocument(luminance: number) {
    const document = createRasterDocument(9, 1, { backgroundColor: "#000000" });
    // A single white impulse makes any blur at the centre unambiguous.
    const basePixels = document.layers[0]!.tiles.toPixels();
    basePixels.set([255, 255, 255, 255], 2 * 4);
    document.layers[0]!.tiles = TileStore.fromPixels(basePixels, 9, 1);
    const glass = createRasterLayer(9, 1, "Glass");
    const glassPixels = glass.tiles.toPixels();
    glassPixels.set([luminance, luminance, luminance, 255], 4 * 4);
    glass.tiles = TileStore.fromPixels(glassPixels, 9, 1);
    glass.effects = { glass: { enabled: true, blur: 6, tintOpacity: 0, invertLuminance: false } };
    appendLayer(document, glass);
    return document;
  }

  it("uses source lightness as the frost map and leaves black pixels sharp", () => {
    const white = compositeRasterDocument(backdropDocument(255));
    const black = compositeRasterDocument(backdropDocument(0));
    // The backdrop at x=4 is black. White glass borrows the neighbouring
    // white impulse through blur; black glass has zero frost strength.
    expect(white[4 * 4]).toBeGreaterThan(0);
    expect(black.slice(4 * 4, 4 * 4 + 4)).toEqual(new Uint8ClampedArray([0, 0, 0, 255]));
  });

  it("does not change pixels outside the glass coverage", () => {
    const result = compositeRasterDocument(backdropDocument(255));
    expect(result.slice(0, 4)).toEqual(new Uint8ClampedArray([0, 0, 0, 255]));
  });

  it("renders a small tile identically to the same part of the full glass composite", () => {
    const document = backdropDocument(255);
    const full = compositeRasterDocument(document);
    const tile = compositeRasterRegion(document, { x: 4, y: 0, width: 1, height: 1 });
    expect(tile).toEqual(full.slice(4 * 4, 5 * 4));
  });

  it("does not inflate blur radius in a reduced-resolution preview", () => {
    const document = backdropDocument(255);
    const full = compositeRasterDocument(document);
    const reduced = compositeRasterRegion(document, { x: 0, y: 0, width: 9, height: 1 }, { step: 2 });
    expect(reduced.slice(2 * 4, 3 * 4)).toEqual(full.slice(4 * 4, 5 * 4));
  });
});
