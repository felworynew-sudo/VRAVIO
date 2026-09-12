import { describe, expect, it } from "vitest";
import { createPolygonSelection } from "./selection";

describe("polygon selection bounds", () => {
  it("accepts a dense freehand contour without spreading its points into Math.min/max", () => {
    const points = [{ x: 1, y: 1 }];
    // A pointer can easily report this many redundant samples during a long
    // tablet stroke. The outline is still just a rectangle, but its top edge
    // intentionally has enough vertices to exercise the argument-limit case.
    for (let index = 0; index < 140_000; index += 1) points.push({ x: 1 + index % 6, y: 1 });
    points.push({ x: 7, y: 1 }, { x: 7, y: 7 }, { x: 1, y: 7 });

    const selection = createPolygonSelection(10, 10, points);
    expect(selection.mask[4 * 10 + 4]).toBe(255);
    expect(selection.bounds).toEqual({ x: 1, y: 1, width: 6, height: 6 });
  });
});
