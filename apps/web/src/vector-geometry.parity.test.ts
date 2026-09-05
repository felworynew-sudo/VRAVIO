import { describe, expect, it } from "vitest";
import { createReferenceGeometryPort, type BooleanOpKind, type FlatPolygon } from "@vravio/kernel";
import { pointInPolygon } from "@vravio/env-vector";
import { createWasmGeometryPort } from "./vector-geometry-wasm";

/**
 * Stage 7 of docs/vector-plan.md: "one test suite runs on both
 * implementations; a mismatch counts as a bug on the WASM side" — this is
 * that suite. It runs every boolean op on both `VectorGeometryPort`s
 * (`createReferenceGeometryPort` from `@vravio/kernel`, `createWasmGeometryPort`
 * from the sibling `vector-geometry-wasm.ts`) and checks they drew the same
 * shape.
 *
 * "Same shape" is checked by sampling, not by comparing vertex arrays: the
 * two implementations are different algorithms (`polygon-clipping`'s
 * Martinez-Rueda in JS vs. `geo-booleanop`'s in Rust) and have no reason to
 * emit vertices in the same order, starting point, or winding direction even
 * when the polygon they describe is identical. A dense grid of point-in-
 * polygon checks over the shapes' shared bounding box, offset off any
 * integer coordinate so no sample point can land exactly on a shared edge or
 * vertex (where the two algorithms' rounding could legitimately disagree),
 * is what "the same shape" actually has to mean here.
 */

function rectangle(x: number, y: number, width: number, height: number): FlatPolygon {
  return new Float64Array([x, y, x + width, y, x + width, y + height, x, y + height]);
}

function toPoints(flat: FlatPolygon): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < flat.length; i += 2) points.push({ x: flat[i]!, y: flat[i + 1]! });
  return points;
}

function containsPoint(polygons: readonly FlatPolygon[], point: { x: number; y: number }): boolean {
  return polygons.some((polygon) => pointInPolygon(toPoints(polygon), point));
}

function boundsOf(...flats: readonly FlatPolygon[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const group of flats) for (const flat of group) for (const p of toPoints(flat)) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Every sample offset by .37/.41 — never on an integer, so it can never
 * land exactly on one of these fixtures' integer-coordinate edges. */
function sampleGrid(bounds: ReturnType<typeof boundsOf>, step = 1): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let x = bounds.minX - 1; x <= bounds.maxX + 1; x += step) {
    for (let y = bounds.minY - 1; y <= bounds.maxY + 1; y += step) points.push({ x: x + 0.37, y: y + 0.41 });
  }
  return points;
}

const fixtures: Record<string, [FlatPolygon, FlatPolygon]> = {
  "overlapping squares": [rectangle(0, 0, 10, 10), rectangle(5, 5, 10, 10)],
  "disjoint squares": [rectangle(0, 0, 10, 10), rectangle(20, 20, 10, 10)],
  "one fully inside the other": [rectangle(0, 0, 10, 10), rectangle(2, 2, 4, 4)],
  "identical squares": [rectangle(0, 0, 10, 10), rectangle(0, 0, 10, 10)],
  "touching edges, no overlap area": [rectangle(0, 0, 10, 10), rectangle(10, 0, 10, 10)],
};

const ops: readonly BooleanOpKind[] = ["union", "subtract", "intersect", "exclude"];

describe("VectorGeometryPort — TS reference vs WASM parity", () => {
  const reference = createReferenceGeometryPort();
  const wasm = createWasmGeometryPort();

  for (const [fixtureName, [subject, clip]] of Object.entries(fixtures)) {
    for (const op of ops) {
      it(`${op} of "${fixtureName}" draws the same shape on both implementations`, async () => {
        const referenceResult = await reference.booleanOp(op, subject, clip);
        const wasmResult = await wasm.booleanOp(op, subject, clip);
        const bounds = boundsOf([subject, clip]);
        const samples = sampleGrid(bounds, 1);
        expect(samples.length).toBeGreaterThan(50);
        for (const point of samples) {
          expect(containsPoint(wasmResult, point)).toBe(containsPoint(referenceResult, point));
        }
      });
    }
  }

  it("is non-vacuous: a deliberately wrong WASM decode is caught by this same grid", async () => {
    const referenceResult = await reference.booleanOp("union", rectangle(0, 0, 10, 10), rectangle(5, 5, 10, 10));
    const wrongResult = [rectangle(100, 100, 1, 1)]; // nowhere near the real union
    const bounds = boundsOf([rectangle(0, 0, 10, 10), rectangle(5, 5, 10, 10)]);
    const samples = sampleGrid(bounds, 1);
    const mismatches = samples.filter((point) => containsPoint(wrongResult, point) !== containsPoint(referenceResult, point));
    expect(mismatches.length).toBeGreaterThan(0);
  });
});
