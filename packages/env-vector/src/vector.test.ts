import { describe, expect, it } from "vitest";
import { createShape, createVectorDocument } from "./document";
import { addShape, duplicateShape, moveShapeInStack, removeShapes, shapeAt, shapeBounds, translateShape, updateShape } from "./shape-ops";

describe("vector document", () => {
  it("creates an empty document with the requested size", () => {
    const state = createVectorDocument(800, 600);
    expect(state).toMatchObject({ kind: "vector", width: 800, height: 600, shapes: [] });
  });

  it("adds a shape and makes it the active selection", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 10, 20);
    addShape(state, rect);
    expect(state.shapes).toHaveLength(1);
    expect(state.activeShapeId).toBe(rect.id);
    expect(state.selection).toEqual([rect.id]);
  });

  it("hit-tests the topmost shape at a point", () => {
    const state = createVectorDocument();
    const back = createShape("rectangle", 0, 0);
    const front = createShape("rectangle", 0, 0);
    addShape(state, back);
    addShape(state, front);
    expect(shapeAt(state, 5, 5)).toBe(front);
    expect(shapeAt(state, 500, 500)).toBeNull();
  });

  it("translates a rectangle and a path the same way", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 10, 10);
    addShape(state, rect);
    translateShape(state, rect.id, 5, -5);
    expect(state.shapes[0]).toMatchObject({ x: 15, y: 5 });
  });

  it("updates a shape by id without touching the others", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 0, 0);
    const b = createShape("ellipse", 0, 0);
    addShape(state, a); addShape(state, b);
    updateShape(state, a.id, { width: 999 });
    expect((state.shapes[0] as { width: number }).width).toBe(999);
    expect((state.shapes[1] as { width: number }).width).toBe(160);
  });

  it("reorders the stack front/back/forward/backward", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 0, 0), b = createShape("rectangle", 0, 0), c = createShape("rectangle", 0, 0);
    addShape(state, a); addShape(state, b); addShape(state, c);
    moveShapeInStack(state, a.id, "front");
    expect(state.shapes.map((shape) => shape.id)).toEqual([b.id, c.id, a.id]);
    moveShapeInStack(state, a.id, "back");
    expect(state.shapes.map((shape) => shape.id)).toEqual([a.id, b.id, c.id]);
  });

  it("duplicates a shape with a fresh id right above the source", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0);
    addShape(state, rect);
    const copy = duplicateShape(state, rect.id);
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(rect.id);
    expect(state.shapes.map((shape) => shape.id)).toEqual([rect.id, copy!.id]);
  });

  it("removes shapes and clears them from selection and active", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0);
    addShape(state, rect);
    removeShapes(state, [rect.id]);
    expect(state.shapes).toHaveLength(0);
    expect(state.activeShapeId).toBeNull();
    expect(state.selection).toEqual([]);
  });

  /**
   * docs/vector-plan.md §2.1 names this as a real, measured bug: `shapeBounds`
   * for a path does `Math.min(...xs, 0)`, so the zero in the list stretches
   * every path's bounds to the origin. This test pins the current *wrong*
   * answer on purpose — it is the canary stage 3 of that plan is supposed to
   * kill. When bounds are fixed to actually track the path's own points, this
   * test starts failing; that failure is stage 3 succeeding, and the fix is to
   * delete this test and replace it with the correct-bounds one the plan
   * calls for, not to update the expectation to match new wrong output.
   */
  it("path bounds stretch to the origin — the bug docs/vector-plan.md §2.1 describes", () => {
    const state = createVectorDocument();
    const path = createShape("path", 500, 500);
    path.points = [{ x: 500, y: 500 }, { x: 600, y: 500 }, { x: 600, y: 600 }];
    addShape(state, path);

    // A correct bounds for this 100x100 path would be {x:500, y:500,
    // width:100, height:100}. This asserts the bug's actual output instead —
    // see the doc comment above for why.
    expect(shapeBounds(path)).toEqual({ x: 0, y: 0, width: 600, height: 600 });
  });
});
