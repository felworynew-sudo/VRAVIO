import { describe, expect, it } from "vitest";
import { createShape, createVectorDocument } from "./document";
import { createVectorGroup } from "./group-ops";
import { rotationMatrixAround } from "./matrix";
import { addShape } from "./shape-ops";
import { appendShapeAt, flattenVectorShapes, isShapeEffectivelyLocked, isShapeEffectivelyVisible, vectorShapeDescendantIds, vectorShapeRows, worldTransform } from "./tree";

describe("vector tree", () => {
  it("flattens a group's children immediately after it, nested groups included", () => {
    const state = createVectorDocument();
    const group = createVectorGroup();
    appendShapeAt(state, group, null);
    const inner = createVectorGroup("Inner");
    appendShapeAt(state, inner, group.id);
    const a = createShape("rectangle", 0, 0);
    appendShapeAt(state, a, group.id);
    const b = createShape("ellipse", 0, 0);
    appendShapeAt(state, b, inner.id);
    const top = createShape("rectangle", 0, 0);
    appendShapeAt(state, top, null);

    expect(flattenVectorShapes(state.shapes).map((shape) => shape.id)).toEqual([group.id, inner.id, b.id, a.id, top.id]);
  });

  it("orders panel rows topmost-first and excludes descendants of a collapsed group", () => {
    const state = createVectorDocument();
    const group = createVectorGroup();
    (group as { expanded: boolean }).expanded = false;
    appendShapeAt(state, group, null);
    const child = createShape("rectangle", 0, 0);
    appendShapeAt(state, child, group.id);
    const top = createShape("ellipse", 0, 0);
    appendShapeAt(state, top, null);

    const collapsedRows = vectorShapeRows(state.shapes).map((row) => row.shape.id);
    expect(collapsedRows).toEqual([top.id, group.id]);

    (group as { expanded: boolean }).expanded = true;
    const expandedRows = vectorShapeRows(state.shapes).map((row) => ({ id: row.shape.id, depth: row.depth }));
    expect(expandedRows).toEqual([{ id: top.id, depth: 0 }, { id: group.id, depth: 0 }, { id: child.id, depth: 1 }]);
  });

  it("lists every descendant at any depth, not just direct children", () => {
    const state = createVectorDocument();
    const outer = createVectorGroup("Outer");
    appendShapeAt(state, outer, null);
    const inner = createVectorGroup("Inner");
    appendShapeAt(state, inner, outer.id);
    const leaf = createShape("rectangle", 0, 0);
    appendShapeAt(state, leaf, inner.id);

    expect(vectorShapeDescendantIds(state.shapes, outer.id).sort()).toEqual([inner.id, leaf.id].sort());
  });

  it("a shape is not effectively visible if any ancestor is hidden, even if the shape's own flag is true", () => {
    const state = createVectorDocument();
    const group = createVectorGroup();
    group.visible = false;
    appendShapeAt(state, group, null);
    const child = createShape("rectangle", 0, 0);
    appendShapeAt(state, child, group.id);

    expect(child.visible).toBe(true);
    expect(isShapeEffectivelyVisible(child, state.shapes)).toBe(false);
  });

  it("a shape is effectively locked if any ancestor is locked", () => {
    const state = createVectorDocument();
    const group = createVectorGroup();
    group.locked = true;
    appendShapeAt(state, group, null);
    const child = createShape("rectangle", 0, 0);
    appendShapeAt(state, child, group.id);

    expect(child.locked).toBe(false);
    expect(isShapeEffectivelyLocked(child, state.shapes)).toBe(true);
  });

  it("worldTransform composes every ancestor's transform, outermost first", () => {
    const state = createVectorDocument();
    const group = createVectorGroup();
    group.transform = rotationMatrixAround(90, 0, 0);
    appendShapeAt(state, group, null);
    const child = createShape("rectangle", 5, 0);
    appendShapeAt(state, child, group.id);

    // The child's own transform is identity, so its world transform should be
    // exactly the group's — composing with identity changes nothing.
    expect(worldTransform(child, state.shapes)).toEqual(group.transform);
  });

  it("worldTransform for a top-level shape (no parent) is just its own transform", () => {
    const state = createVectorDocument();
    const shape = createShape("rectangle", 0, 0);
    addShape(state, shape);
    expect(worldTransform(shape, state.shapes)).toEqual(shape.transform);
  });

  it("worldTransform does not hang on a corrupted cyclic parentId chain", () => {
    const state = createVectorDocument();
    const a = createVectorGroup("A");
    const b = createVectorGroup("B");
    appendShapeAt(state, a, null);
    appendShapeAt(state, b, a.id);
    (a as { parentId: string | null }).parentId = b.id; // hand-corrupted cycle
    expect(() => worldTransform(a, state.shapes)).not.toThrow();
  });
});
