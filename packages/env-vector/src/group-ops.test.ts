import { describe, expect, it } from "vitest";
import { createShape, createVectorDocument } from "./document";
import { groupShapes, ungroupShapes } from "./group-ops";
import { applyMatrix, rotationMatrixAround } from "./matrix";
import { addShape } from "./shape-ops";
import { shapeWorldBounds } from "./shape-ops";
import { flattenVectorShapes, worldTransform } from "./tree";
import type { VectorShape } from "./types";

describe("group / ungroup", () => {
  it("grouping alone moves nothing — every member keeps its own world transform", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 10, 10), b = createShape("ellipse", 200, 50);
    addShape(state, a); addShape(state, b);
    const beforeA = worldTransform(a, state.shapes), beforeB = worldTransform(b, state.shapes);

    const group = groupShapes(state, [a.id, b.id]);

    expect(group).not.toBeNull();
    expect(worldTransform(a, state.shapes)).toEqual(beforeA);
    expect(worldTransform(b, state.shapes)).toEqual(beforeB);
  });

  it("reparents every grouped member under the new group, keeping their relative order", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 0, 0), b = createShape("ellipse", 0, 0), c = createShape("rectangle", 0, 0);
    addShape(state, a); addShape(state, b); addShape(state, c);

    const group = groupShapes(state, [a.id, c.id])!;

    expect(a.parentId).toBe(group.id);
    expect(c.parentId).toBe(group.id);
    expect(b.parentId).toBeNull();
    // a was added before c, so it stays above c inside the group.
    expect(flattenVectorShapes(state.shapes).map((s) => s.id)).toContain(a.id);
    const order = flattenVectorShapes(state.shapes).map((s) => s.id);
    expect(order.indexOf(a.id)).toBeLessThan(order.indexOf(c.id));
  });

  it("nests groups any depth deep", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 0, 0), b = createShape("ellipse", 0, 0), c = createShape("rectangle", 0, 0);
    addShape(state, a); addShape(state, b); addShape(state, c);

    const inner = groupShapes(state, [a.id, b.id])!;
    const outer = groupShapes(state, [inner.id, c.id])!;

    expect(inner.parentId).toBe(outer.id);
    expect(a.parentId).toBe(inner.id);
    expect(outer.parentId).toBeNull();
  });

  /**
   * The live check docs/vector-plan.md's stage 2 explicitly calls for: group,
   * rotate the group, ungroup — the shapes end up exactly where they were
   * while grouped. This is the pure-math half of that check (the SVG-side
   * half — that a rotated <g> visually matches its un-grouped, transform-
   * baked children — was confirmed in the browser; see the stage 2 commit).
   */
  it("group, rotate the group, ungroup: every child ends up exactly where it was while grouped", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 10, 10), b = createShape("ellipse", 200, 60);
    addShape(state, a); addShape(state, b);
    const group = groupShapes(state, [a.id, b.id])!;

    group.transform = rotationMatrixAround(37, 150, 100);
    const worldABeforeUngroup = worldTransform(a, state.shapes);
    const worldBBeforeUngroup = worldTransform(b, state.shapes);
    // A concrete point in each shape's own local space, carried through its
    // world transform — the thing a renderer or a hit test actually cares
    // about, not the matrix's raw numbers.
    const pointOnA = applyMatrix(worldABeforeUngroup, { x: a.x, y: a.y });
    const pointOnB = applyMatrix(worldBBeforeUngroup, { x: b.x, y: b.y });

    ungroupShapes(state, group.id);

    expect(a.parentId).toBeNull();
    expect(b.parentId).toBeNull();
    const worldAAfter = worldTransform(a, state.shapes), worldBAfter = worldTransform(b, state.shapes);
    const pointOnAAfter = applyMatrix(worldAAfter, { x: a.x, y: a.y });
    const pointOnBAfter = applyMatrix(worldBAfter, { x: b.x, y: b.y });

    expect(pointOnAAfter.x).toBeCloseTo(pointOnA.x, 9);
    expect(pointOnAAfter.y).toBeCloseTo(pointOnA.y, 9);
    expect(pointOnBAfter.x).toBeCloseTo(pointOnB.x, 9);
    expect(pointOnBAfter.y).toBeCloseTo(pointOnB.y, 9);
  });

  it("ungrouping also preserves each child's world bounds — the selection-box-visible version of the same guarantee", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 10, 10);
    addShape(state, a);
    const group = groupShapes(state, [a.id])!;
    group.transform = rotationMatrixAround(90, 90, 60);
    const before = shapeWorldBounds(a, state.shapes);

    ungroupShapes(state, group.id);
    const after = shapeWorldBounds(a, state.shapes);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.width).toBeCloseTo(before.width, 6);
    expect(after.height).toBeCloseTo(before.height, 6);
  });

  it("ungrouping a group removes only the group, not its children, and reparents children to the group's own parent", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 0, 0), b = createShape("ellipse", 0, 0);
    addShape(state, a); addShape(state, b);
    const group = groupShapes(state, [a.id, b.id])!;

    const removed = ungroupShapes(state, group.id);

    expect(removed).toBe(true);
    expect(state.shapes.find((s) => s.id === group.id)).toBeUndefined();
    expect(state.shapes.find((s) => s.id === a.id)).toBeDefined();
    expect(state.shapes.find((s) => s.id === b.id)).toBeDefined();
  });

  /**
   * Grouping and immediately ungrouping an *empty* group used to be the exact
   * bug that crashed the raster environment (packages/env-raster/src/layer-
   * ops.ts's ungroupLayer, "Active raster layer is missing"): the layers
   * panel's own "New Group" makes an empty group and selects it, so
   * activeShapeId pointing at a just-removed group with no children to
   * inherit the selection is not a rare shape at all.
   */
  it("ungrouping an empty active group does not leave activeShapeId pointing at nothing", () => {
    const state = createVectorDocument();
    const sibling = createShape("rectangle", 0, 0);
    addShape(state, sibling);
    const group = createShape("group", 0, 0) as VectorShape & { kind: "group" };
    addShape(state, group); // addShape sets activeShapeId to the group

    expect(state.activeShapeId).toBe(group.id);
    const removed = ungroupShapes(state, group.id);

    expect(removed).toBe(true);
    expect(state.activeShapeId).not.toBe(group.id);
    expect(state.shapes.some((s) => s.id === state.activeShapeId)).toBe(true);
  });

  it("groupShapes returns null for an empty selection instead of creating a pointless empty group", () => {
    const state = createVectorDocument();
    expect(groupShapes(state, [])).toBeNull();
  });

  it("ungroupShapes returns false for a non-group id", () => {
    const state = createVectorDocument();
    const a = createShape("rectangle", 0, 0);
    addShape(state, a);
    expect(ungroupShapes(state, a.id)).toBe(false);
  });
});
