import { describe, expect, it } from "vitest";
import { colorToCss } from "@vravio/kernel";
import { applyMatrix } from "./matrix";
import { pathData } from "./path-data";
import { isVectorDocumentState } from "./types";
import type { VectorDocumentState } from "./types";

/**
 * A v2 document exactly as one would have come out of session storage before
 * stage 2: boolean artboards, per-kind `rotation`, string fill/stroke, no
 * `parentId`/`orderKey`/`transform` at all, and the pre-stage-6 single
 * fill/stroke style. `isVectorDocumentState` is the same load-time gate
 * `packages/env-raster/src/document.ts`'s `isRasterDocumentState` uses for
 * its own v1→v2 migration — calling it is what a real document load does,
 * not a hand-picked shortcut into the migration function, and it carries a
 * document all the way from whatever version it was saved at up to current
 * in one pass (v2 → v3 → v4 → v5), not one migration per stage a load has to
 * happen to run through separately.
 */
function v2Document(): unknown {
  return {
    kind: "vector", schemaVersion: 2, width: 800, height: 600, artboards: false,
    activeShapeId: "rect-1", selection: ["rect-1"],
    shapes: [
      {
        id: "rect-1", kind: "rectangle", name: "Rect", visible: true, locked: false,
        x: 100, y: 100, width: 40, height: 20, rotation: 90, cornerRadius: 0,
        style: { fill: "#5be0b3", stroke: "rgba(10, 20, 30, 0.5)", strokeWidth: 2, opacity: 1 },
      },
      {
        id: "path-1", kind: "path", name: "Path", visible: true, locked: false,
        points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], closed: false,
        style: { fill: null, stroke: null, strokeWidth: 1, opacity: 1 },
      },
    ],
  };
}

describe("vector document v2 → v6 migration", () => {
  it("accepts a v2 document as valid and upgrades it all the way to the current schemaVersion", () => {
    const raw = v2Document();
    expect(isVectorDocumentState(raw)).toBe(true);
    expect((raw as VectorDocumentState).schemaVersion).toBe(6);
  });

  it("turns the boolean artboards flag into an empty array, not a truthy/falsy re-encoding of it", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    expect((raw as VectorDocumentState).artboards).toEqual([]);
  });

  it("adds resolution and displayUnit defaults", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    expect(state.resolution).toBe(72);
    expect(state.displayUnit).toBe("px");
  });

  it("gives every shape parentId: null and a distinct orderKey", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    expect(state.shapes.every((shape) => shape.parentId === null)).toBe(true);
    expect(new Set(state.shapes.map((shape) => shape.orderKey)).size).toBe(state.shapes.length);
  });

  it("bakes the old per-kind rotation into a transform around the shape's own center, and drops the field", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    const rect = state.shapes.find((shape) => shape.id === "rect-1")!;

    expect("rotation" in rect).toBe(false);
    expect(rect.kind).toBe("rectangle");
    if (rect.kind !== "rectangle") throw new Error("unreachable");
    // Geometry itself (x/y/width/height) is untouched by the migration — only
    // the rotation moves, from a field into the transform.
    expect(rect).toMatchObject({ x: 100, y: 100, width: 40, height: 20 });

    // 90° clockwise (SVG's rotation direction) around this rectangle's own
    // center (120, 110): its top-left corner (100, 100) — offset (-20, -10)
    // from center — lands at offset (10, -20), i.e. (130, 90). Computed
    // independently against the matrix math rather than guessed by hand.
    const corner = applyMatrix(rect.transform, { x: rect.x, y: rect.y });
    expect(corner.x).toBeCloseTo(130, 6);
    expect(corner.y).toBeCloseTo(90, 6);
  });

  it("a shape with no rotation at all gets the identity transform, not an accidental rotation", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    const path = state.shapes.find((shape) => shape.id === "path-1")!;
    expect(path.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  it("converts a stored hex fill and rgba() stroke into a one-entry fill/stroke stack, rendering identically to before", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    const rect = state.shapes.find((shape) => shape.id === "rect-1")!;

    expect(rect.style.fills).toHaveLength(1);
    expect(rect.style.fills[0]!.paint).toEqual({ kind: "color", color: { space: "srgb", components: [0x5b, 0xe0, 0xb3], alpha: 1 } });
    expect(colorToCss(rect.style.fills[0]!.paint.color)).toBe("rgba(91, 224, 179, 1)");
    expect(rect.style.strokes).toHaveLength(1);
    expect(rect.style.strokes[0]!.paint).toEqual({ kind: "color", color: { space: "srgb", components: [10, 20, 30], alpha: 0.5 } });
    // The old strokeWidth: 2 lands on the migrated stroke layer, not lost.
    expect(rect.style.strokes[0]!.width).toBe(2);
    expect(rect.style.fills[0]!.visible).toBe(true);
    expect(rect.style.strokes[0]!.visible).toBe(true);
  });

  it("a null fill/stroke becomes an empty stack, not a stack with a null entry in it", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    const path = state.shapes.find((shape) => shape.id === "path-1")!;
    expect(path.style.fills).toEqual([]);
    expect(path.style.strokes).toEqual([]);
  });

  it("the old fill/stroke/strokeWidth fields are gone after migration, not left dangling alongside the new stacks", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    const rect = state.shapes.find((shape) => shape.id === "rect-1")!;
    expect("fill" in rect.style).toBe(false);
    expect("stroke" in rect.style).toBe(false);
    expect("strokeWidth" in rect.style).toBe(false);
  });

  it("adds object-level opacity and blendMode defaults", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    const rect = state.shapes.find((shape) => shape.id === "rect-1")!;
    expect(rect.style.opacity).toBe(1);
    expect(rect.style.blendMode).toBe("normal");
  });

  it("gives every shape an empty geometry modifier stack (stage 9)", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    for (const shape of state.shapes) expect(shape.geometry).toEqual([]);
  });

  it("is idempotent — migrating an already-migrated document changes nothing further", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const once = JSON.stringify(raw);
    isVectorDocumentState(raw);
    expect(JSON.stringify(raw)).toBe(once);
  });

  it("path geometry (points, closed) is untouched by the migration — pathData renders the same 'd' before and after", () => {
    const raw = v2Document();
    const rawPath = (raw as { shapes: Array<{ id: string; points: unknown; closed: boolean }> }).shapes.find((shape) => shape.id === "path-1")!;
    const before = pathData(rawPath.points as never, rawPath.closed);

    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    const path = state.shapes.find((shape) => shape.id === "path-1")!;
    if (path.kind !== "path") throw new Error("unreachable");
    const after = pathData(path.points, path.closed);
    expect(after).toBe(before);
  });
});
