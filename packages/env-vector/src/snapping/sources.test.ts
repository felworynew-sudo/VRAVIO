import { describe, expect, it } from "vitest";
import { createShape, createVectorDocument } from "../document";
import { createVectorGroup, groupShapes } from "../group-ops";
import { addShape } from "../shape-ops";
import { appendShapeAt } from "../tree";
import bounds from "./sources/bounds";
import grid from "./sources/grid";
import nodes from "./sources/nodes";
import segmentMidpoints from "./sources/segment-midpoints";
import type { SnapContext } from "./types";

function context(overrides: Partial<SnapContext> = {}): SnapContext {
  return { shapes: [], excludeIds: new Set(), gridSpacing: null, documentWidth: 200, documentHeight: 100, ...overrides };
}

describe("grid source", () => {
  it("produces no lines when spacing is null or non-positive", () => {
    expect(grid.collect(context({ gridSpacing: null }))).toEqual([]);
    expect(grid.collect(context({ gridSpacing: 0 }))).toEqual([]);
    expect(grid.collect(context({ gridSpacing: -10 }))).toEqual([]);
  });

  it("covers exactly the document extent, no further", () => {
    const lines = grid.collect(context({ gridSpacing: 50 }));
    const xValues = lines.filter((line) => line.axis === "x").map((line) => line.value);
    const yValues = lines.filter((line) => line.axis === "y").map((line) => line.value);
    expect(xValues).toEqual([0, 50, 100, 150, 200]);
    expect(yValues).toEqual([0, 50, 100]);
  });
});

describe("bounds source", () => {
  it("excludes a shape in excludeIds", () => {
    const state = createVectorDocument();
    const shape = createShape("rectangle", 0, 0);
    addShape(state, shape);
    expect(bounds.collect(context({ shapes: state.shapes, excludeIds: new Set([shape.id]) }))).toEqual([]);
  });

  it("excludes an empty group — nothing to align to", () => {
    const state = createVectorDocument();
    const group = createVectorGroup();
    appendShapeAt(state, group, null);
    expect(bounds.collect(context({ shapes: state.shapes }))).toEqual([]);
  });

  it("a group with children contributes its union bounds, not per-child lines under its own id", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 0, 0), b = createShape("rectangle", 200, 0);
    addShape(state, a); addShape(state, b);
    const group = groupShapes(state, [a.id, b.id])!;
    const lines = bounds.collect(context({ shapes: state.shapes }));
    const groupLines = lines.filter((line) => line.ownerId === group.id);
    // Union of a (0..160) and b (200..360) is 0..360.
    expect(groupLines.some((line) => line.axis === "x" && line.value === 0)).toBe(true);
    expect(groupLines.some((line) => line.axis === "x" && line.value === 360)).toBe(true);
  });
});

describe("nodes source", () => {
  it("a group contributes no anchor points of its own", () => {
    const state = createVectorDocument();
    const group = createVectorGroup();
    appendShapeAt(state, group, null);
    const child = createShape("rectangle", 10, 10);
    appendShapeAt(state, child, group.id);
    const lines = nodes.collect(context({ shapes: state.shapes }));
    expect(lines.some((line) => line.ownerId === group.id)).toBe(false);
    // The child, a real shape, still contributes its own corners.
    expect(lines.some((line) => line.ownerId === child.id)).toBe(true);
  });

  it("a text shape contributes nothing — it has no anchor points of its own yet", () => {
    const state = createVectorDocument();
    const text = createShape("text", 50, 50);
    addShape(state, text);
    expect(nodes.collect(context({ shapes: state.shapes }))).toEqual([]);
  });

  it("a path's every point is a node, transformed into world space through its own transform", () => {
    const state = createVectorDocument();
    const path = createShape("path", 0, 0);
    if (path.kind === "path") path.points = [{ x: 10, y: 10 }, { x: 20, y: 30 }];
    addShape(state, path);
    const lines = nodes.collect(context({ shapes: state.shapes }));
    const xs = lines.filter((line) => line.axis === "x").map((line) => line.value).sort((a, b) => a - b);
    expect(xs).toEqual([10, 20]);
  });
});

describe("segment-midpoints source", () => {
  it("an open path's last-to-first edge is not a segment — no closing midpoint", () => {
    const state = createVectorDocument();
    const path = createShape("path", 0, 0);
    if (path.kind === "path") { path.points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]; path.closed = false; }
    addShape(state, path);
    const lines = segmentMidpoints.collect(context({ shapes: state.shapes }));
    // Two segments only: (0,0)-(100,0) midpoint (50,0), and (100,0)-(100,100)
    // midpoint (100,50) — never (100,100)-(0,0)'s midpoint (50,50).
    const xs = new Set(lines.filter((line) => line.axis === "x").map((line) => line.value));
    expect(xs.has(50) && xs.has(100)).toBe(true);
    const ys = new Set(lines.filter((line) => line.axis === "y").map((line) => line.value));
    expect(ys.has(0) && ys.has(50)).toBe(true);
  });

  it("a closed path's last-to-first edge is a real segment with its own midpoint", () => {
    const state = createVectorDocument();
    const path = createShape("path", 0, 0);
    if (path.kind === "path") { path.points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]; path.closed = true; }
    addShape(state, path);
    const lines = segmentMidpoints.collect(context({ shapes: state.shapes }));
    // The closing edge (100,100)→(0,0) has midpoint (50,50).
    const has5050 = lines.some((line) => line.axis === "x" && line.value === 50) && lines.some((line) => line.axis === "y" && line.value === 50);
    expect(has5050).toBe(true);
  });

  it("a rectangle's four edge midpoints", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0); // 160x100
    addShape(state, rect);
    const lines = segmentMidpoints.collect(context({ shapes: state.shapes }));
    const points = new Set(lines.map((line) => `${line.axis}:${line.value}`));
    expect(points.has("x:80")).toBe(true); // top/bottom edge midpoints share x=80
    expect(points.has("y:50")).toBe(true); // left/right edge midpoints share y=50
  });
});
