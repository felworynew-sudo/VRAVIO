import { describe, expect, it } from "vitest";
import { adjustedPixels } from "./apply";
import { rasterAdjustments } from "./registry";

describe("raster adjustment modules", () => {
  it("discovers every definition once and in menu order", () => {
    expect(rasterAdjustments.length).toBeGreaterThanOrEqual(9);
    expect(new Set(rasterAdjustments.map((item) => item.id)).size).toBe(rasterAdjustments.length);
    expect(rasterAdjustments.map((item) => item.order)).toEqual([...rasterAdjustments.map((item) => item.order)].sort((a, b) => a - b));
    expect(rasterAdjustments.find((item) => item.id === "levels")?.shortcut).toBe("Ctrl+L");
  });

  it("keeps preview calculations immutable and confines them to a selection", () => {
    const source = new Uint8ClampedArray([10, 20, 30, 255, 50, 60, 70, 255]);
    const selection = { mask: new Uint8ClampedArray([255, 0]), bounds: { x: 0, y: 0, width: 1, height: 1 } };
    const result = adjustedPixels(source, { kind: "invert" }, selection);
    expect([...source]).toEqual([10, 20, 30, 255, 50, 60, 70, 255]);
    expect([...result]).toEqual([245, 235, 225, 255, 50, 60, 70, 255]);
  });
});
