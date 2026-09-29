import { describe, expect, it } from "vitest";
import { createRectangleSelection } from "./selection";
import { fillSelectionInMask, punchSelectionIntoMask, transformLayerPixels, transformSelection } from "./transform";

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

/**
 * Free Transform's outline has to land where its pixels do (docs/master-plan.md §65.1): the
 * selection used to stay behind, un-turned, while the object rotated away from it.
 */
describe("transformSelection", () => {
  const width = 40, height = 40;
  const square = () => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 10; y < 20; y += 1) for (let x = 10; x < 20; x += 1) pixels.set([0, 0, 0, 255], (y * width + x) * 4);
    return { pixels, selection: createRectangleSelection(width, height, 10, 10, 20, 20) };
  };

  it.each([
    ["turned", { x: 10, y: 10, width: 10, height: 10 }, 35],
    ["scaled", { x: 8, y: 12, width: 16, height: 6 }, 0],
    ["scaled and turned", { x: 12, y: 12, width: 14, height: 8 }, -50],
  ] as const)("covers exactly the pixels the same transform moved — %s", (_label, target, degrees) => {
    const { pixels, selection } = square();
    const source = { x: 10, y: 10, width: 10, height: 10 };
    const moved = transformLayerPixels(pixels, width, height, source, target, degrees, selection, false);
    const outline = transformSelection(selection, width, height, source, target, degrees)!;
    expect(outline).not.toBeNull();
    for (let index = 0; index < width * height; index += 1) expect(outline.mask[index]! > 0, `pixel ${index}`).toBe(moved[index * 4 + 3]! > 0);
  });

  it("mirrors the mask the way a flipped transform mirrors the pixels", () => {
    const selection = createRectangleSelection(width, height, 10, 10, 20, 20);
    selection.mask.fill(0);
    for (let y = 10; y < 20; y += 1) selection.mask[y * width + 10] = 255; // left column only
    const flipped = transformSelection(selection, width, height, { x: 10, y: 10, width: 10, height: 10 }, { x: 10, y: 10, width: 10, height: 10 }, 0, { flipX: true })!;
    expect(flipped.mask[15 * width + 19]).toBe(255);
    expect(flipped.mask[15 * width + 10]).toBe(0);
  });

  it("returns null for no selection", () => {
    expect(transformSelection(null, width, height, { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }, 10)).toBeNull();
  });
});
