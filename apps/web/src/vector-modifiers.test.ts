import { describe, expect, it } from "vitest";
import { applyModifierStack, basePathFor, createShape, emptyVectorStyle, solidFill, type ModifierContext, type VectorShape } from "@vravio/env-vector";
import { srgb } from "@vravio/kernel";
import { createWasmCurvePort, createWasmGeometryPort } from "./vector-geometry-wasm";

/**
 * Stage 9 of docs/vector-plan.md's WASM-backed modifiers (`offset`,
 * `simplify`, `boolean`) against the real compiled `.wasm` — the pure-TS
 * ones (`roundCorners`, `zigzag`) already have their own coverage in
 * `@vravio/env-vector`'s `modifiers/apply.test.ts`, which doesn't need any
 * of this file's lazy-loaded ports.
 *
 * The stage's own acceptance test — "round a rectangle, offset it, go back
 * and change its width, everything recomputes" — is the last one here,
 * exercised at the level that actually matters: `applyModifierStack` given
 * the real registry and real ports, not the React hook wrapping it
 * (`vector-modifiers.ts`'s `useModifierResults`), since this repo has no
 * component-testing harness to render a hook with. That hook's own
 * cache-by-revision behavior was checked live in the browser instead — see
 * vector-plan.md's Stage 9 write-up.
 */

function rect(width = 100, height = 100): VectorShape {
  return { ...createShape("rectangle", 0, 0, { ...emptyVectorStyle(), fills: [solidFill(srgb(0, 0, 0))] }), width, height } as VectorShape;
}

function context(otherShapes: readonly VectorShape[] = []): ModifierContext {
  return {
    curvePort: createWasmCurvePort(),
    geometryPort: createWasmGeometryPort(),
    resolveShapePath: (id) => {
      const other = otherShapes.find((shape) => shape.id === id);
      return other ? basePathFor(other) : null;
    },
  };
}

function bounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } {
  const numbers = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    minX = Math.min(minX, numbers[i]!); maxX = Math.max(maxX, numbers[i]!);
    minY = Math.min(minY, numbers[i + 1]!); maxY = Math.max(maxY, numbers[i + 1]!);
  }
  return { minX, minY, maxX, maxY };
}

describe("offset modifier — real WASM", () => {
  it("grows a rectangle's bounding box by the offset amount", async () => {
    const shape = rect(100, 100);
    const withOffset: VectorShape = { ...shape, geometry: [{ id: "m1", kind: "offset", enabled: true, amount: 10, join: "round" }] } as VectorShape;
    const result = (await applyModifierStack(withOffset, withOffset.geometry, context()))!;
    const b = bounds(result);
    expect(b.minX).toBeCloseTo(-10, 0);
    expect(b.maxX).toBeCloseTo(110, 0);
  });
});

describe("simplify modifier — real WASM", () => {
  it("is a no-op-ish pass on an already-simple rectangle (nothing redundant to remove)", async () => {
    const shape = rect(100, 100);
    const withSimplify: VectorShape = { ...shape, geometry: [{ id: "m1", kind: "simplify", enabled: true, accuracy: 1 }] } as VectorShape;
    const result = await applyModifierStack(withSimplify, withSimplify.geometry, context());
    expect(result).toBeTruthy();
    const b = bounds(result!);
    expect(b.maxX - b.minX).toBeCloseTo(100, 0);
  });
});

describe("boolean modifier — real WASM", () => {
  it("unions this shape with another shape's own base path", async () => {
    const a = rect(100, 100);
    const b = { ...rect(100, 100), id: "other-rect" } as VectorShape;
    (b as { x: number }).x = 50;
    const withBoolean: VectorShape = { ...a, geometry: [{ id: "m1", kind: "boolean", enabled: true, op: "union", withShapeId: b.id }] } as VectorShape;
    const result = (await applyModifierStack(withBoolean, withBoolean.geometry, context([b])))!;
    const bnds = bounds(result);
    // a is [0,100]x[0,100], b is [50,150]x[0,100] — their union spans [0,150]x[0,100].
    expect(bnds.minX).toBeCloseTo(0, 0);
    expect(bnds.maxX).toBeCloseTo(150, 0);
  });

  it("leaves the shape unchanged if the other shape no longer exists", async () => {
    const a = rect(100, 100);
    const withBoolean: VectorShape = { ...a, geometry: [{ id: "m1", kind: "boolean", enabled: true, op: "union", withShapeId: "gone" }] } as VectorShape;
    const result = await applyModifierStack(withBoolean, withBoolean.geometry, context([]));
    expect(result).toBe(basePathFor(a));
  });
});

describe("the stage's own acceptance test", () => {
  it("round a rectangle's corners, offset it, then change its width — the result recomputes, not stays stale", async () => {
    const modifiers: VectorShape["geometry"] = [
      { id: "round", kind: "roundCorners", enabled: true, radius: 10 },
      { id: "offset", kind: "offset", enabled: true, amount: 5, join: "round" },
    ];
    const original = rect(100, 100);
    const originalResult = (await applyModifierStack(original, modifiers, context()))!;

    const widened = { ...original, width: 300 } as VectorShape;
    const widenedResult = (await applyModifierStack(widened, modifiers, context()))!;

    expect(widenedResult).not.toBe(originalResult);
    const originalBounds = bounds(originalResult);
    const widenedBounds = bounds(widenedResult);
    // Original: ~100 wide rounded-then-offset rectangle. Widened: ~300 wide.
    // Both pipelines ran round -> offset fresh against their own current
    // base geometry — a stale cache would have kept the original's ~100-wide
    // result even after width changed to 300.
    expect(widenedBounds.maxX - widenedBounds.minX).toBeGreaterThan(originalBounds.maxX - originalBounds.minX + 100);
  });
});
