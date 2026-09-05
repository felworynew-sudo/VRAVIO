import { describe, expect, it } from "vitest";
import { srgb } from "@vravio/kernel";
import { emptyVectorStyle, solidFill, solidStroke } from "./appearance";
import { createShape } from "./document";
import { hitTestShape, shapeBounds } from "./shape-ops";
import type { VectorShape } from "./types";

const black = srgb(0, 0, 0);

const filled = (kind: "rectangle" | "ellipse", x: number, y: number, extra: Partial<VectorShape> = {}): VectorShape => ({
  ...createShape(kind, x, y),
  style: { ...emptyVectorStyle(), fills: [solidFill(black)] },
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
    const shape: VectorShape = { ...createShape("rectangle", 0, 0), style: emptyVectorStyle() } as VectorShape;
    expect(hitTestShape(shape, 50, 25)).toBe(false);
  });

  it("a stroke-only rectangle hits near its edge and misses in the empty middle", () => {
    const shape: VectorShape = {
      ...createShape("rectangle", 0, 0), style: { ...emptyVectorStyle(), strokes: [solidStroke(black, 4)] },
    } as VectorShape;
    expect(hitTestShape(shape, 0, 50)).toBe(true); // on the left edge
    expect(hitTestShape(shape, 80, 50)).toBe(false); // well inside, no fill to hit
  });

  it("a line hits near its segment and misses far away, using its own stroke width as tolerance", () => {
    const shape: VectorShape = {
      ...createShape("line", 0, 0), x1: 0, y1: 0, x2: 100, y2: 0,
      style: { ...emptyVectorStyle(), strokes: [solidStroke(black, 10)] },
    } as VectorShape;
    expect(hitTestShape(shape, 50, 3)).toBe(true); // 3 units off a 10-wide stroke
    expect(hitTestShape(shape, 50, 50)).toBe(false); // far off
  });

  it("an unstroked line is never hit — a line has no fill at all, so with no stroke there is nothing to click on", () => {
    const shape: VectorShape = { ...createShape("line", 0, 0), x1: 0, y1: 0, x2: 100, y2: 0, style: emptyVectorStyle() } as VectorShape;
    expect(hitTestShape(shape, 50, 0)).toBe(false);
  });

  it("a fill layer that exists but is turned off does not count as a fill to hit", () => {
    const shape: VectorShape = { ...createShape("rectangle", 0, 0), style: { ...emptyVectorStyle(), fills: [{ ...solidFill(black), visible: false }] } } as VectorShape;
    expect(hitTestShape(shape, 50, 25)).toBe(false);
  });

  it("only the widest of several visible strokes governs the hit tolerance", () => {
    const shape: VectorShape = {
      ...createShape("line", 0, 0), x1: 0, y1: 0, x2: 100, y2: 0,
      style: { ...emptyVectorStyle(), strokes: [solidStroke(black, 2), solidStroke(black, 20)] },
    } as VectorShape;
    expect(hitTestShape(shape, 50, 8)).toBe(true); // 8 units off — inside the 20-wide stroke, outside the 2-wide one
  });

  it("a path hit-tests its fill as though closed, even when the path's own closed flag is false — matching how SVG fills an open d", () => {
    const shape: VectorShape = {
      ...createShape("path", 0, 0), closed: false,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      style: { ...emptyVectorStyle(), fills: [solidFill(black)] },
    } as VectorShape;
    expect(hitTestShape(shape, 50, 50)).toBe(true);
  });

  it("a path's stroke test follows only its actual segments when open, not the implicit closing edge", () => {
    const shape: VectorShape = {
      ...createShape("path", 0, 0), closed: false,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }],
      style: { ...emptyVectorStyle(), strokes: [solidStroke(black, 4)] },
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
    const stroked: VectorShape = { ...unstroked, style: { ...unstroked.style, strokes: [solidStroke(black, 8)] } };
    expect(shapeBounds(stroked)).toEqual({ x: 6, y: 6, width: 108, height: 58 });
    expect(shapeBounds(unstroked)).toEqual({ x: 10, y: 10, width: 100, height: 50 });
  });

  it("padding uses the widest visible stroke, not the first or the sum of all of them", () => {
    const shape = filled("rectangle", 10, 10, { width: 100, height: 50, cornerRadius: 0 } as Partial<VectorShape>);
    const multiStroke: VectorShape = { ...shape, style: { ...shape.style, strokes: [solidStroke(black, 2), solidStroke(black, 20), solidStroke(black, 6)] } };
    expect(shapeBounds(multiStroke)).toEqual({ x: 0, y: 0, width: 120, height: 70 }); // padded by 20/2 = 10
  });

  it("a stroke layer that is turned off does not pad the bounds", () => {
    const shape = filled("rectangle", 10, 10, { width: 100, height: 50, cornerRadius: 0 } as Partial<VectorShape>);
    const hiddenStroke: VectorShape = { ...shape, style: { ...shape.style, strokes: [{ ...solidStroke(black, 40), visible: false }] } };
    expect(shapeBounds(hiddenStroke)).toEqual({ x: 10, y: 10, width: 100, height: 50 });
  });

  it("an image's bounds are never padded for stroke — an image has no stroke concept to speak of", () => {
    const image: VectorShape = { ...createShape("rectangle", 0, 0), kind: "image", pixelAssetId: "a" } as unknown as VectorShape;
    expect(shapeBounds(image)).toEqual({ x: 0, y: 0, width: 160, height: 100 });
  });
});
