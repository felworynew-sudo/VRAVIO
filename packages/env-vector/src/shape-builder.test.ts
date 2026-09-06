import { describe, expect, it } from "vitest";
import { createReferenceGeometryPort } from "@vravio/kernel";
import { buildShapeBuilderFaces, faceContainsPoint, unionFaces } from "./shape-builder";

/** A closed square, flattened to `[x0, y0, x1, y1, ...]` — `createReferenceGeometryPort`'s
 * own pure-TS boolean-op implementation needs no WASM, so this file runs the same way
 * every other pure `packages/env-vector` unit test does. */
function square(x: number, y: number, size: number): Float64Array {
  return new Float64Array([x, y, x + size, y, x + size, y + size, x, y + size]);
}

describe("buildShapeBuilderFaces", () => {
  const port = createReferenceGeometryPort();

  it("gives a single shape a single face owned by itself", async () => {
    const faces = await buildShapeBuilderFaces(port, [{ id: "a", polygon: square(0, 0, 10) }]);
    expect(faces.length).toBe(1);
    expect(faces[0]!.sourceIds).toEqual(["a"]);
  });

  it("splits two overlapping squares into exactly three faces: A-only, B-only, A∩B", async () => {
    // A: (0,0)-(10,10); B: (5,5)-(15,15) — a 5x5 overlap in the middle.
    const faces = await buildShapeBuilderFaces(port, [
      { id: "a", polygon: square(0, 0, 10) },
      { id: "b", polygon: square(5, 5, 10) },
    ]);
    expect(faces.length).toBe(3);
    const byOwners = new Map(faces.map((face) => [face.sourceIds.join(","), face]));
    expect(byOwners.has("a")).toBe(true); // A-only (the L-shaped remainder)
    expect(byOwners.has("b")).toBe(true); // B-only
    expect(byOwners.has("a,b")).toBe(true); // the overlap, topmost (a) owns the style

    // The overlap face should contain a point deep inside the shared 5x5 square.
    const overlap = byOwners.get("a,b")!;
    expect(faceContainsPoint(overlap.polygon, 7, 7)).toBe(true);
    // ...but not a point only A covers.
    expect(faceContainsPoint(overlap.polygon, 2, 2)).toBe(false);
  });

  it("gives two disjoint (non-overlapping) squares two independent faces", async () => {
    const faces = await buildShapeBuilderFaces(port, [
      { id: "a", polygon: square(0, 0, 10) },
      { id: "b", polygon: square(100, 100, 10) },
    ]);
    expect(faces.length).toBe(2);
    expect(new Set(faces.map((face) => face.sourceIds.join(",")))).toEqual(new Set(["a", "b"]));
  });

  it("attributes a triple overlap to all three sources, topmost first", async () => {
    // All three squares share the point (10, 10).
    const faces = await buildShapeBuilderFaces(port, [
      { id: "a", polygon: square(0, 0, 12) },
      { id: "b", polygon: square(4, 4, 12) },
      { id: "c", polygon: square(8, 8, 12) },
    ]);
    const triple = faces.find((face) => face.sourceIds.length === 3);
    expect(triple, "expected one face owned by all three shapes").toBeDefined();
    expect(triple!.sourceIds).toEqual(["a", "b", "c"]);
    expect(faceContainsPoint(triple!.polygon, 10, 10)).toBe(true);
  });

  it("unionFaces merges the chosen faces into one polygon covering both", async () => {
    const faces = await buildShapeBuilderFaces(port, [
      { id: "a", polygon: square(0, 0, 10) },
      { id: "b", polygon: square(5, 5, 10) },
    ]);
    const merged = await unionFaces(port, faces, faces.map((_, index) => index));
    expect(merged.length).toBe(1);
    // The merged shape should cover points from both original squares, corner to corner.
    expect(faceContainsPoint(merged[0]!, 1, 1)).toBe(true);
    expect(faceContainsPoint(merged[0]!, 14, 14)).toBe(true);
  });
});
