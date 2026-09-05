import { describe, expect, it } from "vitest";
import { createShape } from "./document";
import { hitTestShape, shapeBounds } from "./shape-ops";
import type { VectorShape } from "./types";

const filled = (kind: "rectangle" | "ellipse", x: number, y: number, extra: Partial<VectorShape> = {}): VectorShape => ({
  ...createShape(kind, x, y),
  style: { fill: { space: "srgb", components: [0, 0, 0], alpha: 1 }, stroke: null, strokeWidth: 2, opacity: 1 },
  ...extra,
} as VectorShape);

describe("hitTestShape — real fill/stroke geometry (docs/vector-plan.md bug §2.2)", () => {
  it("a rounded rectangle misses a click in its rounded-off corner even though the corner is inside the bounding box", () => {
    const shape = filled("rectangle", 0, 0, { width: 100, height: 100, cornerRadius: 40 } as Partial<VectorShape>);
    // (2,2) is inside the bbox but well outside the rounded corner's arc.
    expect(hitTestShape(shape, 2, 2)).toBe(false);
    expect(hitTestShape(shape, 50, 50)).toBe(true);
  });

  it("a plain (radius 0) rectangle still hits its own corner — the rounding-aware test does not over-correct", () => {
    const shape = filled("rectangle", 0, 0, { width: 100, height: 100, cornerRadius: 0 } as Partial<VectorShape>);
    expect(hitTestShape(shape, 1, 1)).toBe(true);
  });

  it("an ellipse misses a click in the bbox corner outside its curve — the same bug class as a rounded rectangle, on the shape that motivated it", () => {
    const shape = filled("ellipse", 0, 0, { width: 100, height: 60 } as Partial<VectorShape>);
    expect(hitTestShape(shape, 2, 2)).toBe(false); // corner of the 100x60 bbox, well outside the ellipse
    expect(hitTestShape(shape, 50, 30)).toBe(true); // center
  });

  it("an unfilled, unstroked shape cannot be hit at all — there is nothing to click on", () => {
    const shape: VectorShape = { ...createShape("rectangle", 0, 0), style: { fill: null, stroke: null, strokeWidth: 2, opacity: 1 } } as VectorShape;
    expect(hitTestShape(shape, 50, 25)).toBe(false);
  });

  it("a stroke-only rectangle hits near its edge and misses in the empty middle", () => {
    const shape: VectorShape = {
      ...createShape("rectangle", 0, 0), style: { fill: null, stroke: { space: "srgb", components: [0, 0, 0], alpha: 1 }, strokeWidth: 4, opacity: 1 },
    } as VectorShape;
    expect(hitTestShape(shape, 0, 50)).toBe(true); // on the left edge
    expect(hitTestShape(shape, 80, 50)).toBe(false); // well inside, no fill to hit
  });

  it("a line hits near its segment and misses far away, using its own stroke width as tolerance", () => {
    const shape: VectorShape = {
      ...createShape("line", 0, 0), x1: 0, y1: 0, x2: 100, y2: 0,
      style: { fill: null, stroke: { space: "srgb", components: [0, 0, 0], alpha: 1 }, strokeWidth: 10, opacity: 1 },
    } as VectorShape;
    expect(hitTestShape(shape, 50, 3)).toBe(true); // 3 units off a 10-wide stroke
    expect(hitTestShape(shape, 50, 50)).toBe(false); // far off
  });

  it("an unstroked line is never hit — matches its own kind's fill: null, stroke: null rule, since a line has no fill at all", () => {
    const shape: VectorShape = { ...createShape("line", 0, 0), x1: 0, y1: 0, x2: 100, y2: 0, style: { fill: null, stroke: null, strokeWidth: 2, opacity: 1 } } as VectorShape;
    expect(hitTestShape(shape, 50, 0)).toBe(false);
  });

  it("a path hit-tests its fill as though closed, even when the path's own closed flag is false — matching how SVG fills an open d", () => {
    const shape: VectorShape = {
      ...createShape("path", 0, 0), closed: false,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      style: { fill: { space: "srgb", components: [0, 0, 0], alpha: 1 }, stroke: null, strokeWidth: 2, opacity: 1 },
    } as VectorShape;
    expect(hitTestShape(shape, 50, 50)).toBe(true);
  });

  it("a path's stroke test follows only its actual segments when open, not the implicit closing edge", () => {
    const shape: VectorShape = {
      ...createShape("path", 0, 0), closed: false,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }],
      style: { fill: null, stroke: { space: "srgb", components: [0, 0, 0], alpha: 1 }, strokeWidth: 4, opacity: 1 },
    } as VectorShape;
    expect(hitTestShape(shape, 50, 0)).toBe(true); // on the first real segment
    expect(hitTestShape(shape, 50, 50)).toBe(false); // on the closing edge, which an open path's stroke never draws
  });

  it("a group is never hit — there is nothing of a group's own to click on", () => {
    const group: VectorShape = { ...createShape("group", 0, 0) } as VectorShape;
    expect(hitTestShape(group, 0, 0)).toBe(false);
  });
});

describe("shapeBounds — stroke padding", () => {
  it("a stroked shape's bounds are larger than its fill geometry by half the stroke width on every side", () => {
    const unstroked = filled("rectangle", 10, 10, { width: 100, height: 50, cornerRadius: 0 } as Partial<VectorShape>);
    const stroked: VectorShape = { ...unstroked, style: { ...unstroked.style, stroke: { space: "srgb", components: [0, 0, 0], alpha: 1 }, strokeWidth: 8 } };
    expect(shapeBounds(stroked)).toEqual({ x: 6, y: 6, width: 108, height: 58 });
    expect(shapeBounds(unstroked)).toEqual({ x: 10, y: 10, width: 100, height: 50 });
  });

  it("an image's bounds are never padded for stroke — an image has no stroke concept to speak of", () => {
    const image: VectorShape = { ...createShape("rectangle", 0, 0), kind: "image", pixelAssetId: "a" } as unknown as VectorShape;
    expect(shapeBounds(image)).toEqual({ x: 0, y: 0, width: 160, height: 100 });
  });
});
