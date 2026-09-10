import { describe, expect, it } from "vitest";
import { createRectangleSelection } from "./selection";
import { fillSelectedPixels } from "./fill";

/**
 * Alt/Ctrl+Delete and the Fill dialog's own opacity slider — reported live
 * by the user alongside `punchSelectionIntoMask` (transform.test.ts), same
 * request for the layer-pixel half of Photoshop's Fill hotkeys.
 */
describe("fillSelectedPixels", () => {
  it("paints solid color over the selection, leaves pixels outside it untouched", () => {
    const width = 3, height = 1;
    const pixels = new Uint8ClampedArray([10, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 255]);
    const selection = createRectangleSelection(width, height, 1, 0, 2, 1);
    const result = fillSelectedPixels(pixels, width, height, selection, { r: 200, g: 100, b: 50, a: 255 });
    expect(Array.from(result.subarray(0, 4))).toEqual([10, 10, 10, 255]); // outside
    expect(Array.from(result.subarray(4, 8))).toEqual([200, 100, 50, 255]); // inside
  });

  it("fills the whole layer when there is no selection", () => {
    const width = 2, height = 1;
    const pixels = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]);
    const result = fillSelectedPixels(pixels, width, height, null, { r: 255, g: 0, b: 0, a: 255 });
    expect(Array.from(result)).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
  });

  it("scales how far the fill lands by opacity, same as the Fill dialog's slider", () => {
    const width = 1, height = 1;
    const pixels = new Uint8ClampedArray([0, 0, 0, 255]);
    const result = fillSelectedPixels(pixels, width, height, null, { r: 200, g: 200, b: 200, a: 255 }, 0.5);
    expect(Array.from(result)).toEqual([100, 100, 100, 255]);
  });

  it("does not mutate the input buffer", () => {
    const width = 1, height = 1;
    const pixels = new Uint8ClampedArray([9, 9, 9, 255]);
    fillSelectedPixels(pixels, width, height, null, { r: 1, g: 2, b: 3, a: 255 });
    expect(Array.from(pixels)).toEqual([9, 9, 9, 255]);
  });
});
