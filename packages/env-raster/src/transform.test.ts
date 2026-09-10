import { describe, expect, it } from "vitest";
import { createRectangleSelection } from "./selection";
import { fillSelectionInMask, punchSelectionIntoMask } from "./transform";

/**
 * Delete on a mask being edited, with a pixel selection active, has to punch
 * a hole in the mask (paint the selection black) rather than delete the mask
 * outright — found live, reported by the user: pressing Delete with a
 * selection removed the whole mask instead of just hiding the selected area,
 * the one behaviour Delete never has on an ordinary layer.
 */
describe("punchSelectionIntoMask", () => {
  it("zeroes mask pixels fully covered by the selection, leaves the rest untouched", () => {
    const width = 4, height = 4;
    const pixels = new Uint8ClampedArray(width * height).fill(255);
    const selection = createRectangleSelection(width, height, 1, 1, 3, 3);
    const result = punchSelectionIntoMask(pixels, width, height, selection);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const inside = x >= 1 && x < 3 && y >= 1 && y < 3;
      expect(result[index]).toBe(inside ? 0 : 255);
    }
  });

  it("scales toward zero by partial (feathered) coverage instead of an all-or-nothing cut", () => {
    const width = 2, height = 1;
    const pixels = new Uint8ClampedArray([200, 200]);
    const selection = createRectangleSelection(width, height, 0, 0, 2, 1);
    selection.mask[0] = 128; // half coverage on the left pixel only
    selection.mask[1] = 255;
    const result = punchSelectionIntoMask(pixels, width, height, selection);
    expect(result[0]).toBe(Math.round(200 * (1 - 128 / 255)));
    expect(result[1]).toBe(0);
  });

  it("does not mutate the input buffer", () => {
    const width = 2, height = 1;
    const pixels = new Uint8ClampedArray([255, 255]);
    const selection = createRectangleSelection(width, height, 0, 0, 2, 1);
    punchSelectionIntoMask(pixels, width, height, selection);
    expect(Array.from(pixels)).toEqual([255, 255]);
  });
});

/**
 * Alt/Ctrl+Backspace filling white or black while editing a mask — the
 * general painter `punchSelectionIntoMask` above now delegates to.
 */
describe("fillSelectionInMask", () => {
  it("paints toward the target value over the selection, leaves the rest alone", () => {
    const width = 3, height = 1;
    const pixels = new Uint8ClampedArray([0, 0, 0]);
    const selection = createRectangleSelection(width, height, 1, 0, 2, 1);
    const result = fillSelectionInMask(pixels, width, height, selection, 255);
    expect(Array.from(result)).toEqual([0, 255, 0]);
  });

  it("fills the whole mask when there is no selection", () => {
    const width = 2, height = 1;
    const pixels = new Uint8ClampedArray([10, 200]);
    const result = fillSelectionInMask(pixels, width, height, null, 0);
    expect(Array.from(result)).toEqual([0, 0]);
  });
});
