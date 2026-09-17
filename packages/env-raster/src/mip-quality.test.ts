import { describe, expect, it } from "vitest";
import { compositeRasterRegion, createRasterDocument, setLayerPixels } from "./index";

/** White canvas with one-pixel black lines — the content point sampling breaks up at low zoom. */
function finePattern(width: number, height: number) {
  const document = createRasterDocument(width, height);
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const ink = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < width && y < height) { const index = (y * width + x) * 4; pixels[index] = 0; pixels[index + 1] = 0; pixels[index + 2] = 0; } };
  for (let line = 0; line < 12; line += 1) for (let x = 0; x < width; x += 1) ink(x, Math.round(10 + line * 13 + x * 0.21));
  for (let x = 1; x < width; x += 3) for (let y = 0; y < height; y += 1) if (y > height * 0.7) ink(x, y);
  setLayerPixels(document.layers[0]!, pixels, width, height);
  return document;
}

/** The reference: the full-resolution composite, each step×step block averaged. */
function reference(full: Uint8ClampedArray, width: number, height: number, step: number) {
  const outWidth = Math.ceil(width / step), outHeight = Math.ceil(height / step);
  const output = new Float64Array(outWidth * outHeight);
  for (let row = 0; row < outHeight; row += 1) for (let column = 0; column < outWidth; column += 1) {
    let sum = 0, count = 0;
    for (let y = row * step; y < Math.min(height, (row + 1) * step); y += 1) for (let x = column * step; x < Math.min(width, (column + 1) * step); x += 1) { sum += full[(y * width + x) * 4]!; count += 1; }
    output[row * outWidth + column] = sum / count;
  }
  return output;
}

const meanError = (sampled: Uint8ClampedArray, expected: Float64Array) => {
  let total = 0;
  for (let index = 0; index < expected.length; index += 1) total += Math.abs(sampled[index * 4]! - expected[index]!);
  return total / expected.length;
};

describe("zoomed-out composites average instead of point-sampling", () => {
  for (const step of [2, 4, 16]) {
    it(`step ${step} stays close to the true downscale`, () => {
      const document = finePattern(256, 256);
      const full = compositeRasterRegion(document, { x: 0, y: 0, width: 256, height: 256 });
      const expected = reference(full, 256, 256, step);
      const averaged = compositeRasterRegion(document, { x: 0, y: 0, width: 256, height: 256 }, { step });
      const pointSampled = compositeRasterRegion(document, { x: 0, y: 0, width: 256, height: 256 }, { step, pointSample: true });
      const averagedError = meanError(averaged, expected), pointError = meanError(pointSampled, expected);
      // eslint-disable-next-line no-console
      console.log(`step ${step}: mean error averaged ${averagedError.toFixed(1)} vs point-sampled ${pointError.toFixed(1)}`);
      expect(averagedError).toBeLessThan(pointError * 0.7);
    });
  }
});
