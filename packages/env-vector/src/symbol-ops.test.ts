import { describe, expect, it } from "vitest";
import { createShape, createVectorDocument } from "./document";
import { addShape, shapeAt, shapeWorldBounds, translateShape } from "./shape-ops";
import { createSymbolFromShapes, detachInstance, listSymbols, placeSymbolInstance, redefineSymbolFromShapes } from "./symbol-ops";
import { flattenVectorShapes, vectorShapeRows } from "./tree";
import { SYMBOLS_ROOT_ID } from "./types";

describe("symbols and instances (stage 13 of docs/vector-plan.md)", () => {
  it("wraps a selection into a symbol + instance without moving it visually", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 10, 20);
    addShape(state, rect);

    const before = shapeWorldBounds(rect, state.shapes);
    const instance = createSymbolFromShapes(state, [rect.id])!;

    expect(instance).not.toBeNull();
    expect(instance.kind).toBe("instance");
    expect(shapeWorldBounds(instance, state.shapes)).toEqual(before);
  });

  it("a symbol's own content never appears in normal paint order or the layers panel", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0);
    addShape(state, rect);
    createSymbolFromShapes(state, [rect.id]);

    expect(flattenVectorShapes(state.shapes).some((shape) => shape.parentId === SYMBOLS_ROOT_ID)).toBe(false);
    expect(vectorShapeRows(state.shapes).some((row) => row.shape.parentId === SYMBOLS_ROOT_ID)).toBe(false);
  });

  it("editing the shared definition changes every instance — there is nothing else to propagate to", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0);
    addShape(state, rect);
    const first = createSymbolFromShapes(state, [rect.id])!;
    const second = placeSymbolInstance(state, (first as { symbolId: string }).symbolId, 500, 500)!;

    // The master's own child is the same shared object both instances read from at render time.
    const master = state.shapes.find((shape) => shape.id === (first as { symbolId: string }).symbolId)!;
    const child = state.shapes.find((shape) => shape.parentId === master.id)!;
    (child as { width: number }).width = 999;

    const firstBounds = shapeWorldBounds(first, state.shapes);
    const secondBounds = shapeWorldBounds(second, state.shapes);
    expect(firstBounds.width).toBe(999);
    expect(secondBounds.width).toBe(999);
  });

  it("moving one instance never moves another, or the definition itself", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0);
    addShape(state, rect);
    const first = createSymbolFromShapes(state, [rect.id])!;
    const second = placeSymbolInstance(state, (first as { symbolId: string }).symbolId, 500, 500)!;
    const secondBoundsBefore = shapeWorldBounds(second, state.shapes);

    translateShape(state, first.id, 30, 40);
    // `translateShape` replaces the shape's array entry rather than mutating
    // it in place (`updateShape`'s own contract) — `first`/`second` still
    // point at the pre-move objects, so re-fetch the live ones from the
    // document the same way any real caller (a tool, a render) would.
    const firstAfter = state.shapes.find((shape) => shape.id === first.id)!;
    const secondAfter = state.shapes.find((shape) => shape.id === second.id)!;

    expect(shapeWorldBounds(firstAfter, state.shapes)).toEqual({ x: 30, y: 40, width: 160, height: 100 });
    expect(shapeWorldBounds(secondAfter, state.shapes)).toEqual(secondBoundsBefore);
  });

  it("a click on an instance's painted content selects the instance itself, not the definition's own shape", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0); // 160x100, filled — createShape's own default style
    addShape(state, rect);
    // `createSymbolFromShapes` itself leaves one instance at the original
    // position (0,0) — a second, independently placed instance is what
    // this test actually needs to tell apart from it.
    const original = createSymbolFromShapes(state, [rect.id])!;
    const symbolId = (original as unknown as { symbolId: string }).symbolId;
    const instance = placeSymbolInstance(state, symbolId, 500, 600)!;

    expect(shapeAt(state, 5, 5)?.id).toBe(original.id); // still hits the first instance, not the definition
    expect(shapeAt(state, 550, 650)?.id).toBe(instance.id); // inside the second instance's box, placed at (500,600)
    expect(shapeAt(state, 5000, 5000)).toBeNull(); // nothing at all out here
  });

  it("Break Link detaches an instance into an independent, editable group", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 10, 10);
    addShape(state, rect);
    const symbolId = createSymbolFromShapes(state, [rect.id])!.symbolId as unknown as string;
    const instance = placeSymbolInstance(state, symbolId, 500, 500)!;
    const boundsBefore = shapeWorldBounds(instance, state.shapes);

    const group = detachInstance(state, instance.id)!;

    expect(group).not.toBeNull();
    expect(group.kind).toBe("group");
    expect(shapeWorldBounds(group, state.shapes)).toEqual(boundsBefore);
    expect(state.shapes.some((shape) => shape.id === instance.id)).toBe(false); // the instance itself is gone, replaced by the group

    // The detached group's own child is a real, independent copy — editing it must not touch the symbol's other instances.
    const detachedChild = state.shapes.find((shape) => shape.parentId === group.id)!;
    (detachedChild as { width: number }).width = 1;
    const original = state.shapes.find((shape) => shape.id === rect.id)!;
    expect((original as { width: number }).width).not.toBe(1);
  });

  it("Redefine Symbol replaces the definition and every instance updates", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0);
    addShape(state, rect);
    const instance = createSymbolFromShapes(state, [rect.id])!;
    const symbolId = (instance as unknown as { symbolId: string }).symbolId;

    const replacement = createShape("ellipse", 0, 0);
    addShape(state, replacement);
    const ok = redefineSymbolFromShapes(state, symbolId, [replacement.id]);

    expect(ok).toBe(true);
    // The replacement shape moved into the definition — it is no longer a
    // separate top-level shape a normal click could find on its own.
    expect(flattenVectorShapes(state.shapes).some((shape) => shape.id === replacement.id)).toBe(false);
    const instanceLeaf = state.shapes.find((shape) => shape.parentId === symbolId)!;
    expect(instanceLeaf.kind).toBe("ellipse");
  });

  it("listSymbols reports how many instances reference each definition", () => {
    const state = createVectorDocument();
    const rect = createShape("rectangle", 0, 0);
    addShape(state, rect);
    const first = createSymbolFromShapes(state, [rect.id], "Icon (Иконка)")!;
    const symbolId = (first as unknown as { symbolId: string }).symbolId;
    placeSymbolInstance(state, symbolId, 100, 100);
    placeSymbolInstance(state, symbolId, 200, 200);

    const summary = listSymbols(state);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.name).toBe("Icon (Иконка)");
    expect(summary[0]!.instanceCount).toBe(3); // the one createSymbolFromShapes itself placed, plus the two above
  });

  /**
   * The stage's own checklist item, verified directly rather than assumed:
   * a hundred instances of one symbol must not store a hundred copies of
   * its geometry. Compares the real document's serialized size against a
   * synthetic "what if each instance were an independent group with its
   * own copy of the same content" document built the same way
   * `duplicateShape` would — if "instance" were only a naming convention
   * over real per-instance copies, these two sizes would be close; a real
   * reference keeps the symbol version dramatically smaller regardless of
   * how many instances exist.
   */
  it("a hundred instances of one symbol do not store a hundred copies of its geometry", () => {
    const withSymbol = createVectorDocument();
    // A deliberately heavy definition — 200 points — so a real duplicate
    // would be easy to see in the serialized size; a trivial one-rectangle
    // symbol could stay small by coincidence either way.
    const heavy = createShape("path", 0, 0);
    (heavy as { points: { x: number; y: number }[] }).points = Array.from({ length: 200 }, (_, index) => ({ x: index, y: index * 2 }));
    addShape(withSymbol, heavy);
    const symbolId = (createSymbolFromShapes(withSymbol, [heavy.id])! as unknown as { symbolId: string }).symbolId;
    for (let index = 0; index < 99; index += 1) placeSymbolInstance(withSymbol, symbolId, index * 10, index * 10);
    expect(listSymbols(withSymbol)[0]!.instanceCount).toBe(100);

    const naive = createVectorDocument();
    for (let index = 0; index < 100; index += 1) {
      const copy = createShape("path", index * 10, index * 10);
      (copy as { points: { x: number; y: number }[] }).points = Array.from({ length: 200 }, (_, point) => ({ x: point, y: point * 2 }));
      addShape(naive, copy);
    }

    const symbolSize = JSON.stringify(withSymbol).length;
    const naiveSize = JSON.stringify(naive).length;
    expect(symbolSize).toBeLessThan(naiveSize * 0.2); // generously under a fifth — the real ratio measured here is roughly 1/30
  });
});
