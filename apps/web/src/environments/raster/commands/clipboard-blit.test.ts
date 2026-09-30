import { describe, expect, it } from "vitest";
import { layerDocumentPixels } from "@vravio/env-raster";
import { pastedImageLayer } from "./definitions/clipboard";

/**
 * master-plan.md §1.9 item 7: `Mod+Shift+V` (Paste in Place) has to land a copy at the exact
 * document coordinates it came from, not always the canvas top-left `Mod+V` uses; §65.10: what a
 * paste puts past the canvas edge stays in the layer. The command itself reads the real system
 * clipboard, which a browser grants only to a genuine user gesture, so this tests the placement.
 *
 * Lives here, one level above `./definitions/` — `registry.ts`'s glob would otherwise try to
 * register this file as a command module.
 */
describe("pastedImageLayer", () => {
  const RED: readonly [number, number, number, number] = [255, 0, 0, 255];
  const solid = (width: number, height: number) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) pixels.set(RED, index * 4);
    return pixels;
  };
  const at = (buffer: Uint8ClampedArray, width: number, x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
  };

  it("places the image at (0,0) — plain Paste", () => {
    const layer = pastedImageLayer(solid(10, 10), 10, 10, 0, 0, 100, 100);
    const shown = layerDocumentPixels(layer, 100, 100);
    expect(at(shown, 100, 0, 0)).toEqual([...RED]);
    expect(at(shown, 100, 9, 9)).toEqual([...RED]);
    expect(at(shown, 100, 10, 10)).toEqual([0, 0, 0, 0]);
  });

  it("places the image at the remembered copy origin — Paste in Place", () => {
    const layer = pastedImageLayer(solid(10, 10), 10, 10, 30, 40, 100, 100);
    const shown = layerDocumentPixels(layer, 100, 100);
    expect(at(shown, 100, 30, 40)).toEqual([...RED]);
    expect(at(shown, 100, 39, 49)).toEqual([...RED]);
    expect(at(shown, 100, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(shown, 100, 29, 40)).toEqual([0, 0, 0, 0]);
    expect(at(shown, 100, 40, 40)).toEqual([0, 0, 0, 0]);
  });

  it("keeps the part past the canvas edge in the layer instead of cutting it off", () => {
    const layer = pastedImageLayer(solid(10, 10), 10, 10, -5, -5, 20, 20);
    // The whole 10×10 is stored, starting off-canvas.
    expect(layer.bounds).toEqual({ x: -5, y: -5, width: 10, height: 10 });
    // On canvas, only its bottom-right 5×5 shows, at the canvas's own top-left.
    const shown = layerDocumentPixels(layer, 20, 20);
    expect(at(shown, 20, 0, 0)).toEqual([...RED]);
    expect(at(shown, 20, 4, 4)).toEqual([...RED]);
    expect(at(shown, 20, 5, 5)).toEqual([0, 0, 0, 0]);
  });
});
