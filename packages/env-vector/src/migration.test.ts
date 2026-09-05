import { describe, expect, it } from "vitest";
import { colorToCss } from "@vravio/kernel";
import { applyMatrix } from "./matrix";
import { pathData } from "./path-data";
import { isVectorDocumentState } from "./types";
import type { VectorDocumentState } from "./types";

/**
 * A v2 document exactly as one would have come out of session storage before
 * this stage: boolean artboards, per-kind `rotation`, string fill/stroke, no
 * `parentId`/`orderKey`/`transform` at all. `isVectorDocumentState` is the
 * same load-time gate `packages/env-raster/src/document.ts`'s
 * `isRasterDocumentState` uses for its own v1→v2 migration — calling it is
 * what a real document load does, not a hand-picked shortcut into the
 * migration function.
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

describe("vector document v2 → v3 migration", () => {
  it("accepts a v2 document as valid and upgrades it to schemaVersion 3", () => {
    const raw = v2Document();
    expect(isVectorDocumentState(raw)).toBe(true);
    expect((raw as VectorDocumentState).schemaVersion).toBe(3);
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

  it("converts a stored hex fill and rgba() stroke into Color, rendering identically to before", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    const rect = state.shapes.find((shape) => shape.id === "rect-1")!;

    expect(rect.style.fill).toEqual({ space: "srgb", components: [0x5b, 0xe0, 0xb3], alpha: 1 });
    expect(colorToCss(rect.style.fill!)).toBe("rgba(91, 224, 179, 1)");
    expect(rect.style.stroke).toEqual({ space: "srgb", components: [10, 20, 30], alpha: 0.5 });
  });

  it("a null fill/stroke stays null, not converted into some Color", () => {
    const raw = v2Document();
    isVectorDocumentState(raw);
    const state = raw as VectorDocumentState;
    const path = state.shapes.find((shape) => shape.id === "path-1")!;
    expect(path.style.fill).toBeNull();
    expect(path.style.stroke).toBeNull();
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
