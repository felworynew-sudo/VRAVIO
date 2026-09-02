import { describe, expect, it } from "vitest";
import { createRasterLayer, renderLayerEffects } from "./index";
import type { RasterLayer, RasterLayerEffects } from "./types";

const W = 40, H = 40;

/** An opaque square in the middle of a transparent layer. */
function squareLayer(): RasterLayer {
  const layer = createRasterLayer(W, H, "Shape");
  for (let y = 12; y < 28; y += 1) for (let x = 12; x < 28; x += 1) {
    const index = (y * W + x) * 4;
    layer.pixels[index] = 180; layer.pixels[index + 1] = 120; layer.pixels[index + 2] = 90; layer.pixels[index + 3] = 255;
  }
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
    expect(renderLayerEffects(layer, W, H)).toBe(layer.pixels);
    expect(render({ dropShadow: { enabled: false, color: "#000000", opacity: 1, offsetX: 4, offsetY: 4 } }, layer)).toBe(layer.pixels);
  });

  it("never writes into the source buffer", () => {
    const layer = squareLayer();
    const before = layer.pixels.slice();

    render({ dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX: 4, offsetY: 4 } }, layer);

    expect([...layer.pixels]).toEqual([...before]);
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

    const moved = createRasterLayer(W, H, "Moved");
    for (let y = 2; y < 8; y += 1) for (let x = 2; x < 8; x += 1) {
      const index = (y * W + x) * 4;
      moved.pixels[index + 3] = 255;
    }
    layer.pixels = moved.pixels;
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
