import { describe, expect, it } from "vitest";
import { selectionBrushDab, selectionBrushStrokeSegment } from "./selection_brush";

const W = 40, H = 40;

function sum(mask: Uint8ClampedArray): number {
  let total = 0;
  for (const value of mask) total += value;
  return total;
}

describe("selection brush stamping", () => {
  it("add raises the mask under the tip", () => {
    const mask = new Uint8ClampedArray(W * H);
    selectionBrushDab(mask, W, H, 20, 20, 10, 100, 100, 0, "add");
    expect(sum(mask)).toBeGreaterThan(0);
    expect(mask[20 * W + 20]).toBe(255);
  });

  it("subtract on a bare mask is a no-op — there is nothing to erase yet", () => {
    const mask = new Uint8ClampedArray(W * H);
    selectionBrushDab(mask, W, H, 20, 20, 10, 100, 100, 0, "subtract");
    expect(sum(mask)).toBe(0);
  });

  it("subtract over the same spot an add just covered erases it back to zero", () => {
    const mask = new Uint8ClampedArray(W * H);
    selectionBrushDab(mask, W, H, 20, 20, 10, 100, 100, 0, "add");
    const added = sum(mask);
    selectionBrushDab(mask, W, H, 20, 20, 10, 100, 100, 0, "subtract");
    expect(added).toBeGreaterThan(0);
    expect(sum(mask)).toBe(0);
  });

  it("a stroke segment joins dabs along the path instead of leaving dots", () => {
    const mask = new Uint8ClampedArray(W * H);
    selectionBrushStrokeSegment(mask, W, H, 5, 20, 35, 20, 6, 100, 100, 0, "add", 0.18);
    // Every point along the line, not just the two endpoints, should be selected.
    for (let x = 5; x <= 35; x += 5) expect(mask[20 * W + x]).toBeGreaterThan(0);
  });

  it("hardness < 100 softens the edge instead of a binary cutoff", () => {
    const hard = new Uint8ClampedArray(W * H);
    selectionBrushDab(hard, W, H, 20, 20, 20, 100, 100, 0, "add");
    const soft = new Uint8ClampedArray(W * H);
    selectionBrushDab(soft, W, H, 20, 20, 20, 20, 100, 0, "add");
    // Near the tip's edge, the soft brush leaves partial coverage where the hard one is already 0 or fully 255.
    const edgeIndex = 20 * W + 29;
    expect(soft[edgeIndex]).toBeGreaterThan(0);
    expect(soft[edgeIndex]).toBeLessThan(255);
  });
});
