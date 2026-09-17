import { describe, expect, it } from "vitest";
import { createRasterDocument, setLayerPixels } from "@vravio/env-raster";
import type { PendingTransform } from "./definitions/move";
import { quickRotatePending } from "./transform-quick-rotate";

/** The transform bar's Rotate 90° buttons step the session's described angle, never pixels. */
function pending(): PendingTransform {
  const state = createRasterDocument(20, 10);
  const layer = state.layers[0]!;
  const pixels = new Uint8ClampedArray(20 * 10 * 4);
  for (let y = 2; y < 6; y += 1) for (let x = 4; x < 12; x += 1) pixels[(y * 20 + x) * 4 + 3] = 255;
  setLayerPixels(layer, pixels, 20, 10);
  return { before: state, layerId: layer.id, dx: 0, dy: 0, pixels, selection: null, rotation: 0 };
}

describe("quickRotatePending", () => {
  it("describes a turn about the frame without touching the pixels", () => {
    const start = pending();
    const turned = quickRotatePending(start, 20, 10, 90)!;
    expect(turned.live).toEqual({ source: { x: 4, y: 2, width: 8, height: 4 }, target: { x: 4, y: 2, width: 8, height: 4 }, rotation: 90 });
    expect(turned.rotation).toBe(90);
    expect(turned.pixels).toBe(start.pixels);
  });

  it("keeps a scaled session's target and comes back to 0 after four turns", () => {
    let current: PendingTransform = { ...pending(), live: { source: { x: 4, y: 2, width: 8, height: 4 }, target: { x: 2, y: 1, width: 16, height: 8 }, rotation: 0 } };
    for (let step = 0; step < 4; step += 1) current = quickRotatePending(current, 20, 10, -90)!;
    expect(current.live).toEqual({ source: { x: 4, y: 2, width: 8, height: 4 }, target: { x: 2, y: 1, width: 16, height: 8 }, rotation: 0 });
  });

  it("refuses Warp and Skew sessions", () => {
    expect(quickRotatePending({ ...pending(), mesh: [] }, 20, 10, 90)).toBeNull();
    expect(quickRotatePending({ ...pending(), corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }, 20, 10, 90)).toBeNull();
  });
});
