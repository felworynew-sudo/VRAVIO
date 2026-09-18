import { describe, expect, it } from "vitest";
import { createRasterDocument, setLayerPixels, transformLayerInFrame, transformLayerPixels, setLayerFramePixels, layerDocumentPixels } from "./index";

/** docs/master-plan.md §58.3: Flip Horizontal/Vertical inside a transform frame. */
function stripes(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    pixels[index] = x * 8; pixels[index + 1] = y * 8; pixels[index + 2] = 0; pixels[index + 3] = 255;
  }
  return pixels;
}

describe("mirroring a transform", () => {
  const width = 16, height = 12, frame = { x: 0, y: 0, width, height };

  it("flipX reads the source from the far side", () => {
    const source = stripes(width, height);
    const flipped = transformLayerPixels(source, width, height, frame, frame, 0, null, true, { flipX: true });
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4, mirrored = (y * width + (width - 1 - x)) * 4;
      expect(Math.abs(flipped[at]! - source[mirrored]!)).toBeLessThanOrEqual(1);
      expect(flipped[at + 1]).toBe(source[mirrored + 1]);
    }
  });

  it("flipY mirrors rows, and both together mirror twice", () => {
    const source = stripes(width, height);
    const flippedY = transformLayerPixels(source, width, height, frame, frame, 0, null, true, { flipY: true });
    const both = transformLayerPixels(source, width, height, frame, frame, 0, null, true, { flipX: true, flipY: true });
    const at = (x: number, y: number) => (y * width + x) * 4;
    expect(flippedY[at(3, 2) + 1]).toBe(source[at(3, height - 1 - 2) + 1]);
    expect(Math.abs(both[at(3, 2)]! - source[at(width - 1 - 3, height - 1 - 2)]!)).toBeLessThanOrEqual(1);
  });

  it("flipping twice comes back to the original", () => {
    const source = stripes(width, height);
    const once = transformLayerPixels(source, width, height, frame, frame, 0, null, true, { flipX: true });
    const twice = transformLayerPixels(once, width, height, frame, frame, 0, null, true, { flipX: true });
    for (let index = 0; index < source.length; index += 1) expect(Math.abs(twice[index]! - source[index]!)).toBeLessThanOrEqual(2);
  });

  it("a mirrored transform commits over a frame like any other", () => {
    const document = createRasterDocument(width, height);
    const layer = document.layers[0]!;
    setLayerPixels(layer, stripes(width, height), width, height);
    const { pixels, frame: computed } = transformLayerInFrame(layer, width, height, frame, frame, 0, null, { flipX: true });
    setLayerFramePixels(layer, pixels, computed);
    const shown = layerDocumentPixels(layer, width, height);
    expect(Math.abs(shown[(2 * width + 1) * 4]! - (width - 1 - 1) * 8)).toBeLessThanOrEqual(2);
  });
});
