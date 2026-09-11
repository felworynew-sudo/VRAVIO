import { describe, expect, it } from "vitest";
import { createRasterLayer } from "./document";
import { layerDocumentPixels, setLayerPixels } from "./layer-bounds";

const W = 40, H = 40;

/** A document-sized buffer with one solid opaque square painted into it. */
function withSquare(x: number, y: number, size: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) {
    const index = ((y + row) * W + (x + col)) * 4;
    pixels[index] = 200; pixels[index + 1] = 40; pixels[index + 2] = 40; pixels[index + 3] = 255;
  }
  return pixels;
}

/** docs/master-plan.md §32.4's invariant, CLAUDE.md §4: the pair a layer's own buffer
 *  and its recorded bounds must never disagree on, whichever path set them. */
function expectBoundsMatchBuffer(layer: ReturnType<typeof createRasterLayer>): void {
  expect(layer.pixels.length).toBe(layer.bounds.width * layer.bounds.height * 4);
  expect(layer.width).toBe(layer.bounds.width);
  expect(layer.height).toBe(layer.bounds.height);
}

describe("setLayerPixels' §32.6 add-only fast path", () => {
  it("grows the layer's bounds to cover a new stroke, without reading a single pixel", () => {
    const layer = createRasterLayer(W, H, "L");
    setLayerPixels(layer, withSquare(5, 5, 6), W, H);
    expect(layer.bounds).toEqual({ x: 5, y: 5, width: 6, height: 6 });

    // A second stroke elsewhere, hinted as add-only — the new bounds should be the
    // union of the two squares, not a rescan of the whole (by-now two-square) canvas.
    // A real tool paints onto the layer's *current* document-sized content, not a
    // fresh blank buffer — `layerDocumentPixels` is that same materialisation.
    const second = layerDocumentPixels(layer, W, H).slice();
    for (let row = 0; row < 4; row += 1) for (let col = 0; col < 4; col += 1) {
      const index = ((20 + row) * W + (20 + col)) * 4;
      second[index] = 40; second[index + 1] = 200; second[index + 2] = 40; second[index + 3] = 255;
    }
    setLayerPixels(layer, second, W, H, { bounds: { x: 20, y: 20, width: 4, height: 4 }, canShrink: false });

    expect(layer.bounds).toEqual({ x: 5, y: 5, width: 19, height: 19 });
    expectBoundsMatchBuffer(layer);
    // Both squares actually survived the union, not just the bounds rectangle: the
    // first stroke's own pixel and the new stroke's own pixel both read back correctly
    // from the cropped buffer at their respective offsets within it.
    const firstLocal = ((5 - 5) * layer.bounds.width + (5 - 5)) * 4;
    expect([layer.pixels[firstLocal], layer.pixels[firstLocal + 1], layer.pixels[firstLocal + 2]]).toEqual([200, 40, 40]);
    const secondLocal = ((20 - 5) * layer.bounds.width + (20 - 5)) * 4;
    expect([layer.pixels[secondLocal], layer.pixels[secondLocal + 1], layer.pixels[secondLocal + 2]]).toEqual([40, 200, 40]);
  });

  it("a hinted edit outside the document clamps to the document instead of producing an invalid buffer", () => {
    const layer = createRasterLayer(W, H, "L");
    setLayerPixels(layer, withSquare(0, 0, 5), W, H);
    // An edit rectangle that would grow the bounds past the document's own edge —
    // a brush dab near the corner, whose square bounding box overhangs it.
    setLayerPixels(layer, withSquare(0, 0, 5), W, H, { bounds: { x: -10, y: -10, width: 15, height: 15 }, canShrink: false });
    expect(layer.bounds.x).toBeGreaterThanOrEqual(0);
    expect(layer.bounds.y).toBeGreaterThanOrEqual(0);
    expect(layer.bounds.x + layer.bounds.width).toBeLessThanOrEqual(W);
    expect(layer.bounds.y + layer.bounds.height).toBeLessThanOrEqual(H);
    expectBoundsMatchBuffer(layer);
  });

  it("an unhinted edit still scans and can shrink the bounds — the eraser's own path", () => {
    const layer = createRasterLayer(W, H, "L");
    setLayerPixels(layer, withSquare(5, 5, 10), W, H);
    expect(layer.bounds).toEqual({ x: 5, y: 5, width: 10, height: 10 });

    // Erase the square's right-hand edge column — a real shrink, the case the fast
    // path above is never allowed to take.
    const erased = withSquare(5, 5, 10);
    for (let row = 0; row < 10; row += 1) {
      const index = ((5 + row) * W + 14) * 4;
      erased[index + 3] = 0;
    }
    setLayerPixels(layer, erased, W, H, { bounds: { x: 14, y: 5, width: 1, height: 10 }, canShrink: true });

    expect(layer.bounds).toEqual({ x: 5, y: 5, width: 9, height: 10 });
    expectBoundsMatchBuffer(layer);
  });

  it("no edit hint at all still takes the scanning path (every existing caller's own behaviour)", () => {
    const layer = createRasterLayer(W, H, "L");
    setLayerPixels(layer, withSquare(5, 5, 10), W, H);
    const erased = withSquare(5, 5, 10);
    for (let row = 0; row < 10; row += 1) erased[((5 + row) * W + 14) * 4 + 3] = 0;
    setLayerPixels(layer, erased, W, H);
    expect(layer.bounds).toEqual({ x: 5, y: 5, width: 9, height: 10 });
    expectBoundsMatchBuffer(layer);
  });
});
