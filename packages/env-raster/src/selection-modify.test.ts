import { describe, expect, it } from "vitest";
import { contractSelection, expandSelection, smoothSelection } from "./selection-modify";
import { selectionBounds } from "./selection";
import type { PixelSelection } from "./types";

const W = 40, H = 30;

function rect(x: number, y: number, w: number, h: number): PixelSelection {
  const mask = new Uint8ClampedArray(W * H);
  for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) mask[yy * W + xx] = 255;
  return { mask, bounds: selectionBounds(mask, W, H) };
}
const at = (selection: PixelSelection | null, x: number, y: number) => selection?.mask[y * W + x] ?? 0;
const count = (selection: PixelSelection | null) => selection ? selection.mask.reduce((sum, value) => sum + (value ? 1 : 0), 0) : 0;

describe("expandSelection", () => {
  it("grows a rectangle by the radius along the axes, with rounded corners", () => {
    const grown = expandSelection(rect(10, 10, 10, 8), W, H, 3);
    expect(grown?.bounds).toEqual({ x: 7, y: 7, width: 16, height: 14 });
    expect(at(grown, 7, 13)).toBe(255);      // straight out from the left edge
    expect(at(grown, 7, 7)).toBe(0);         // the disc does not reach the diagonal corner
    expect(at(grown, 8, 8)).toBe(255);       // but does reach (−2,−2): 2²+2² ≤ 3²
  });

  it("is clipped at the canvas and leaves the source untouched", () => {
    const source = rect(0, 0, 5, 5);
    const before = source.mask.slice();
    const grown = expandSelection(source, W, H, 4);
    expect(grown?.bounds).toEqual({ x: 0, y: 0, width: 9, height: 9 });
    expect(source.mask).toEqual(before);
  });
});

describe("contractSelection", () => {
  it("shrinks a rectangle by the radius on every side", () => {
    const shrunk = contractSelection(rect(10, 10, 12, 10), W, H, 2);
    expect(shrunk?.bounds).toEqual({ x: 12, y: 12, width: 8, height: 6 });
  });

  it("returns null when nothing survives", () => {
    expect(contractSelection(rect(10, 10, 4, 4), W, H, 3)).toBeNull();
  });

  it("keeps an edge-touching selection at the canvas edge unless told to apply at the bounds", () => {
    const edge = rect(0, 0, 12, 12);
    expect(contractSelection(edge, W, H, 2)?.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(contractSelection(edge, W, H, 2, true)?.bounds).toEqual({ x: 2, y: 2, width: 8, height: 8 });
  });

  it("undoes an expand of a large rectangle exactly", () => {
    const source = rect(8, 8, 20, 14);
    expect(contractSelection(expandSelection(source, W, H, 3), W, H, 3)?.mask).toEqual(source.mask);
  });
});

describe("smoothSelection", () => {
  it("removes an isolated speck and fills a pinhole", () => {
    const selection = rect(10, 8, 16, 14);
    selection.mask[15 * W + 17] = 0;          // pinhole inside
    selection.mask[3 * W + 3] = 255;          // speck far outside
    selection.bounds = selectionBounds(selection.mask, W, H);
    const smooth = smoothSelection(selection, W, H, 2);
    expect(at(smooth, 17, 15)).toBe(255);
    expect(at(smooth, 3, 3)).toBe(0);
    expect(at(smooth, 18, 15)).toBe(255);
  });

  it("rounds a square corner but keeps straight edges", () => {
    const smooth = smoothSelection(rect(10, 10, 12, 12), W, H, 3);
    expect(at(smooth, 10, 10)).toBe(0);      // the corner pixel loses the vote
    expect(at(smooth, 10, 16)).toBe(255);    // the middle of an edge keeps it
    expect(count(smooth)).toBeLessThan(144);
  });

  it("takes the median of soft values, not a threshold", () => {
    const mask = new Uint8ClampedArray(W * H).fill(0);
    for (let y = 5; y < 25; y += 1) for (let x = 5; x < 35; x += 1) mask[y * W + x] = 128;
    const smooth = smoothSelection({ mask, bounds: selectionBounds(mask, W, H) }, W, H, 1);
    expect(at(smooth, 20, 15)).toBe(128);
  });
});
