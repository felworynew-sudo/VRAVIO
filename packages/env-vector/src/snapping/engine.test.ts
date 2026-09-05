import { describe, expect, it } from "vitest";
import { createShape, createVectorDocument } from "./../document";
import { addShape } from "./../shape-ops";
import { resolveSnapForBounds } from "./engine";
import { snapSources } from "./registry";
import type { SnapContext } from "./types";

function context(overrides: Partial<SnapContext> = {}): SnapContext {
  return { shapes: [], excludeIds: new Set(), gridSpacing: null, documentWidth: 1000, documentHeight: 1000, ...overrides };
}

describe("resolveSnapForBounds", () => {
  it("snaps a dragged shape's left edge to another shape's right edge", () => {
    const state = createVectorDocument();
    const target = createShape("rectangle", 0, 0);
    addShape(state, target); // bbox: 0,0 .. 160,100 — right edge at x=160

    // y=200 keeps every y-axis candidate (target's edges at 0/100, center at
    // 50) well outside the radius, so this fixture isolates the x-axis snap
    // the test is actually about.
    const dragged = { x: 163, y: 200, width: 50, height: 50 }; // left edge at 163, 3 units past the target's right edge
    const result = resolveSnapForBounds(dragged, 8, snapSources, context({ shapes: state.shapes, excludeIds: new Set() }));

    expect(result.dx).toBeCloseTo(-3, 9); // moves left edge from 163 to 160
    expect(result.dy).toBe(0); // nothing on the y axis was close enough
    expect(result.lines.some((line) => line.axis === "x" && line.value === 160)).toBe(true);
  });

  it("snaps a dragged shape's center to another shape's center", () => {
    const state = createVectorDocument();
    const target = createShape("rectangle", 100, 100); // bbox 100,100..260,200, center (180,150)
    addShape(state, target);

    const dragged = { x: 20, y: 20, width: 300, height: 260 }; // center (170, 150) — x off by 10, y exact
    const result = resolveSnapForBounds(dragged, 15, snapSources, context({ shapes: state.shapes }));

    expect(result.dx).toBeCloseTo(10, 9);
    expect(result.dy).toBeCloseTo(0, 9);
  });

  it("does not snap to a shape excluded by id — the shape being dragged does not snap to its own bounds", () => {
    const state = createVectorDocument();
    const shape = createShape("rectangle", 0, 0);
    addShape(state, shape);

    const dragged = { x: 2, y: 2, width: 160, height: 100 }; // nearly on top of the shape's own bounds
    const result = resolveSnapForBounds(dragged, 8, snapSources, context({ shapes: state.shapes, excludeIds: new Set([shape.id]) }));

    expect(result.dx).toBe(0);
    expect(result.dy).toBe(0);
  });

  it("nothing within radius snaps to nothing — the honest miss", () => {
    const state = createVectorDocument();
    const target = createShape("rectangle", 0, 0);
    addShape(state, target);

    const dragged = { x: 500, y: 500, width: 50, height: 50 };
    const result = resolveSnapForBounds(dragged, 8, snapSources, context({ shapes: state.shapes }));

    expect(result).toEqual({ dx: 0, dy: 0, lines: [] });
  });

  it("the closest of several candidates on the same axis wins", () => {
    const state = createVectorDocument();
    const near = createShape("rectangle", 0, 0); // right edge at 160
    const far = createShape("rectangle", 400, 0); // left edge at 400
    addShape(state, near); addShape(state, far);

    const dragged = { x: 163, y: 20, width: 20, height: 20 };
    const result = resolveSnapForBounds(dragged, 10, snapSources, context({ shapes: state.shapes }));

    expect(result.dx).toBeCloseTo(-3, 9); // snapped to `near`'s right edge (160), not `far`
  });

  it("grid lines are collected only when gridSpacing is set, and snap independently of other shapes", () => {
    const withoutGrid = resolveSnapForBounds({ x: 48, y: 48, width: 10, height: 10 }, 5, snapSources, context());
    expect(withoutGrid).toEqual({ dx: 0, dy: 0, lines: [] });

    const withGrid = resolveSnapForBounds({ x: 48, y: 48, width: 10, height: 10 }, 5, snapSources, context({ gridSpacing: 50 }));
    expect(withGrid.dx).toBeCloseTo(2, 9); // 48 → nearest multiple of 50 is 50
    expect(withGrid.dy).toBeCloseTo(2, 9);
  });

  it("snaps to a path's anchor node", () => {
    const state = createVectorDocument();
    const path = createShape("path", 0, 0);
    if (path.kind === "path") path.points = [{ x: 300, y: 300 }, { x: 400, y: 300 }];
    addShape(state, path);

    // Three probes per axis (left/center/right edge, top/center/bottom edge
    // of the dragged box) each get compared to the node at (300,300) — the
    // *closest* probe wins, which is the box's center here (302,303), not
    // its top-left corner (297,298) despite that being the one visually
    // "near" the node. Computed against the actual engine rather than
    // guessed by hand, per this session's own recorded lesson about that.
    const dragged = { x: 297, y: 298, width: 10, height: 10 }; // top-left corner near (300,300)
    const result = resolveSnapForBounds(dragged, 6, snapSources, context({ shapes: state.shapes }));

    expect(result.dx).toBeCloseTo(-2, 9); // center probe (302) → node x (300)
    expect(result.dy).toBeCloseTo(2, 9); // top-left probe (298) → node y (300)
  });

  it("snaps to a rectangle's edge midpoint", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0); // 160x100, top-edge midpoint at (80, 0)
    addShape(state, rect);

    // Same reasoning as the node test above: the dragged box's center-x
    // probe (81) is closer to the midpoint's x (80) than its left-edge
    // probe (76) is, so that is the one that wins.
    const dragged = { x: 76, y: -20, width: 10, height: 10 };
    const result = resolveSnapForBounds(dragged, 6, snapSources, context({ shapes: state.shapes }));

    expect(result.dx).toBeCloseTo(-1, 9); // dragged's center-x probe (81) snaps to x=80
  });
});
