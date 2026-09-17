import { describe, expect, it } from "vitest";
import { selectionBounds } from "./selection";
import { frameBounds, mapFramePoint, transformSelectionMask } from "./selection-transform";
import type { PixelSelection } from "./types";

const W = 40, H = 40;
function rect(x: number, y: number, w: number, h: number): PixelSelection {
  const mask = new Uint8ClampedArray(W * H);
  for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) mask[yy * W + xx] = 255;
  return { mask, bounds: selectionBounds(mask, W, H) };
}

describe("transformSelectionMask", () => {
  it("is the identity for an unchanged frame", () => {
    const selection = rect(5, 6, 10, 8);
    const out = transformSelectionMask(selection, W, H, { source: selection.bounds, target: selection.bounds, rotation: 0 });
    expect(out?.mask).toEqual(selection.mask);
  });

  it("moves and scales the outline", () => {
    const selection = rect(5, 5, 10, 10);
    const out = transformSelectionMask(selection, W, H, { source: selection.bounds, target: { x: 12, y: 8, width: 20, height: 10 }, rotation: 0 });
    // Bilinear: at most a one-pixel soft rim past the target where the scale doubled.
    const b = out!.bounds;
    expect(b.x).toBeGreaterThanOrEqual(11); expect(b.x + b.width).toBeLessThanOrEqual(33);
    expect(b.y).toBe(8); expect(b.height).toBe(10);
    expect(out?.mask[13 * W + 22]).toBe(255);
    expect(out?.mask[13 * W + 11]).toBeLessThan(128); // the rim is under half — outside the marching ants
    expect(out?.mask[13 * W + 12]).toBeGreaterThanOrEqual(128);
    expect(out?.mask[7 * W + 7]).toBe(0);
  });

  it("turns a wide rectangle upright at 90°", () => {
    const selection = rect(10, 16, 20, 8);
    const out = transformSelectionMask(selection, W, H, { source: selection.bounds, target: selection.bounds, rotation: 90 });
    expect(out?.bounds).toEqual({ x: 16, y: 10, width: 8, height: 20 });
  });

  it("returns null when the frame leaves the canvas", () => {
    const selection = rect(5, 5, 10, 10);
    expect(transformSelectionMask(selection, W, H, { source: selection.bounds, target: { x: 100, y: 100, width: 10, height: 10 }, rotation: 0 })).toBeNull();
  });
});

describe("frame geometry", () => {
  it("maps the source corners through scale and rotation", () => {
    const frame = { source: { x: 0, y: 0, width: 10, height: 10 }, target: { x: 0, y: 0, width: 20, height: 10 }, rotation: 90 };
    const p = mapFramePoint(frame, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(15); expect(p.y).toBeCloseTo(-5);
    const box = frameBounds(frame);
    expect(box.width).toBeCloseTo(10); expect(box.height).toBeCloseTo(20);
  });
});
