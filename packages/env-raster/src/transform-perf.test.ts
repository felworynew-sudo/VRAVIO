import { describe, expect, it } from "vitest";
import { rotateLayerPixels, rotatedDestinationBounds } from "./index";

/**
 * Rotation used to walk the *whole document* on every frame of a drag: its clearing loop was
 * bounded by the layer, but the loop that drew the result ran `for (y = 0; y < height)` over the
 * canvas. Measured before the fix, rotating a 200x200 layer cost 19ms on a 1920x1080 canvas and
 * 85ms on a 4000x3000 one — the price followed the canvas, not the layer, which is exactly the
 * shape of cost this project's whole layer-bounds optimisation exists to avoid (CLAUDE.md §5).
 *
 * `scaleLayerPixels` and `quadLayerPixels` next door always bounded their destination loops;
 * rotate was the one that did not.
 */

const colour = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => pixels[(y * width + x) * 4 + 3]!;

function layer(width: number, height: number, bounds: { x: number; y: number; width: number; height: number }): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const index = (y * width + x) * 4;
      pixels[index] = 200; pixels[index + 1] = 80; pixels[index + 2] = 40; pixels[index + 3] = 255;
    }
  }
  return pixels;
}

describe("rotation's destination box", () => {
  it("covers the turned rectangle and grows with the angle", () => {
    const bounds = { x: 100, y: 100, width: 200, height: 100 };
    const straight = rotatedDestinationBounds(bounds, 0);
    expect(straight.width).toBeCloseTo(200, 6);
    expect(straight.height).toBeCloseTo(100, 6);
    // At 45° a 200x100 box spans (200+100)/√2 ≈ 212 each way.
    const turned = rotatedDestinationBounds(bounds, 45);
    expect(turned.width).toBeGreaterThan(210);
    expect(turned.height).toBeGreaterThan(210);
    // And it stays centred on the same point, whatever the angle.
    expect(turned.x + turned.width / 2).toBeCloseTo(bounds.x + bounds.width / 2, 6);
    expect(turned.y + turned.height / 2).toBeCloseTo(bounds.y + bounds.height / 2, 6);
  });

  it("is what a quarter turn actually needs, so nothing is clipped", () => {
    // The real check that the bound is not merely small but *correct*: a quarter turn of a wide
    // layer must come out as a tall one, with its far corners present.
    const width = 600, height = 600;
    const bounds = { x: 200, y: 250, width: 200, height: 100 };
    const rotated = rotateLayerPixels(layer(width, height, bounds), width, height, bounds, 90);
    const centreX = bounds.x + bounds.width / 2, centreY = bounds.y + bounds.height / 2;
    // Turned by 90°, the content now spans 100 wide and 200 tall about the same centre.
    expect(colour(rotated, width, Math.round(centreX), Math.round(centreY - 80))).toBeGreaterThan(200);
    expect(colour(rotated, width, Math.round(centreX), Math.round(centreY + 80))).toBeGreaterThan(200);
    // And nothing survives where the box no longer reaches.
    expect(colour(rotated, width, Math.round(centreX + 80), Math.round(centreY))).toBe(0);
  });
});

describe("rotation's sampling", () => {
  it("interpolates on the accurate pass and takes the nearest pixel on the preview one", () => {
    // Krita's Instant Preview split: a cheap approximation while the hand moves, the accurate
    // result once. Measured, bilinear costs about twice nearest on a large layer — worth paying
    // once on release rather than thirty times a second.
    const width = 400, height = 400;
    const bounds = { x: 100, y: 150, width: 200, height: 100 };
    const source = layer(width, height, bounds);
    const accurate = rotateLayerPixels(source, width, height, bounds, 23, null, true);
    const preview = rotateLayerPixels(source, width, height, bounds, 23, null, false);

    const partial = (pixels: Uint8ClampedArray) => {
      let count = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        const alpha = pixels[index]!;
        if (alpha > 0 && alpha < 255) count += 1;
      }
      return count;
    };
    // The interpolated pass has a soft rim; the nearest-neighbour one steps straight from opaque
    // to nothing, which is exactly the difference that makes it cheaper.
    expect(partial(accurate)).toBeGreaterThan(partial(preview) * 2);
  });
});
