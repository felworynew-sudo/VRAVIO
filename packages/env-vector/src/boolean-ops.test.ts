import { describe, expect, it } from "vitest";
import { pathShapeFromPolygon, shapeOutlineWorldPolygon } from "./boolean-ops";
import { createShape, createVectorDocument } from "./document";
import { addShape } from "./shape-ops";
import { emptyVectorStyle } from "./appearance";
import { translationMatrix } from "./matrix";

describe("shapeOutlineWorldPolygon (stage 7, Pathfinder groundwork)", () => {
  it("flattens a rectangle to its own 4 corners in world space", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0);
    Object.assign(rect, { x: 10, y: 20, width: 30, height: 40, cornerRadius: 0 });
    addShape(state, rect);
    const polygon = shapeOutlineWorldPolygon(rect, state.shapes)!;
    expect(polygon).not.toBeNull();
    const xs = [...polygon].filter((_, i) => i % 2 === 0);
    const ys = [...polygon].filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBe(10);
    expect(Math.max(...xs)).toBe(40);
    expect(Math.min(...ys)).toBe(20);
    expect(Math.max(...ys)).toBe(60);
  });

  it("applies the shape's own transform — a translated rectangle's polygon is translated too", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0);
    Object.assign(rect, { x: 0, y: 0, width: 10, height: 10, transform: translationMatrix(100, 200) });
    addShape(state, rect);
    const polygon = shapeOutlineWorldPolygon(rect, state.shapes)!;
    const xs = [...polygon].filter((_, i) => i % 2 === 0);
    const ys = [...polygon].filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBe(100);
    expect(Math.min(...ys)).toBe(200);
  });

  it("flattens an ellipse to a many-sided approximation, not just its 4 bounding corners", () => {
    const state = createVectorDocument();
    const ellipse = createShape("ellipse", 0, 0);
    Object.assign(ellipse, { x: 0, y: 0, width: 100, height: 100 });
    addShape(state, ellipse);
    const polygon = shapeOutlineWorldPolygon(ellipse, state.shapes)!;
    expect(polygon.length / 2).toBeGreaterThan(8);
  });

  it("returns null for shape kinds with no single fill outline (group, line, text)", () => {
    const state = createVectorDocument();
    const line = createShape("line", 0, 0);
    addShape(state, line);
    expect(shapeOutlineWorldPolygon(line, state.shapes)).toBeNull();
  });

  it("a closed path's own points become the polygon, honoring curves via flattening", () => {
    const state = createVectorDocument();
    const path = createShape("path", 0, 0, emptyVectorStyle());
    if (path.kind === "path") { path.points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]; path.closed = true; }
    addShape(state, path);
    const polygon = shapeOutlineWorldPolygon(path, state.shapes)!;
    expect(polygon.length / 2).toBeGreaterThanOrEqual(3);
  });
});

describe("pathShapeFromPolygon", () => {
  it("builds a closed path shape whose points match the flat polygon exactly", () => {
    const polygon = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]);
    const shape = pathShapeFromPolygon(polygon, "Union Result", emptyVectorStyle());
    expect(shape.kind).toBe("path");
    if (shape.kind !== "path") throw new Error("expected a path shape");
    expect(shape.closed).toBe(true);
    expect(shape.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    expect(shape.name).toBe("Union Result");
  });

  it("carries the given style onto the new shape", () => {
    const style = { ...emptyVectorStyle(), opacity: 0.5 };
    const shape = pathShapeFromPolygon(new Float64Array([0, 0, 1, 0, 1, 1]), "R", style);
    expect(shape.style.opacity).toBe(0.5);
  });
});
