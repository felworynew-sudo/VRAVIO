import { describe, expect, it } from "vitest";
import { applyModifierStack } from "./apply";
import { basePathFor } from "./base-path";
import { parseFlatPolygon } from "./svg-path";
import type { GeometryModifier } from "./types";
import { createShape, emptyVectorStyle } from "..";
import type { VectorShape } from "../types";

/**
 * Stage 9 of docs/vector-plan.md: "the reason this whole architecture
 * exists" — a shape's geometry is a *stack*, run in order from its own base
 * outline. These tests cover the two pure-TS modifiers directly
 * (`roundCorners`, `zigzag` — no WASM involved) and the orchestrator that
 * chains any stack together; `offset`/`simplify`/`boolean` (WASM-backed)
 * have their own coverage in `apps/web`, the only package with the lazily-
 * loaded module to actually call.
 */

function rect(width = 100, height = 100): VectorShape {
  return { ...createShape("rectangle", 0, 0, { ...emptyVectorStyle(), fills: [] }), width, height } as VectorShape;
}

function modifier<T extends GeometryModifier>(value: Omit<T, "id" | "enabled"> & { enabled?: boolean }): T {
  return { id: `mod-${Math.random()}`, enabled: true, ...value } as T;
}

describe("basePathFor", () => {
  it("a plain rectangle becomes its own 4-corner polygon", () => {
    const d = basePathFor(rect(100, 50));
    const { points, closed } = parseFlatPolygon(d!);
    expect(closed).toBe(true);
    expect(points).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }]);
  });

  it("returns null for kinds with no fillable outline", () => {
    const line = createShape("line", 0, 0);
    const text = createShape("text", 0, 0);
    expect(basePathFor(line)).toBeNull();
    expect(basePathFor(text)).toBeNull();
  });
});

describe("applyModifierStack", () => {
  it("an empty stack returns exactly the base path", async () => {
    const shape = rect();
    const result = await applyModifierStack(shape, []);
    expect(result).toBe(basePathFor(shape));
  });

  it("a disabled modifier is skipped entirely", async () => {
    const shape = rect();
    const zig = modifier<Extract<GeometryModifier, { kind: "zigzag" }>>({ kind: "zigzag", amplitude: 10, segmentLength: 5, enabled: false });
    const result = await applyModifierStack(shape, [zig]);
    expect(result).toBe(basePathFor(shape));
  });

  it("roundCorners cuts every straight corner into a Q curve, and a bigger radius cuts back further along each edge", async () => {
    const shape = rect(100, 100);
    const small = modifier<Extract<GeometryModifier, { kind: "roundCorners" }>>({ kind: "roundCorners", radius: 5 });
    const large = modifier<Extract<GeometryModifier, { kind: "roundCorners" }>>({ kind: "roundCorners", radius: 30 });
    const smallResult = (await applyModifierStack(shape, [small]))!;
    const largeResult = (await applyModifierStack(shape, [large]))!;
    expect(smallResult).toContain("Q");
    // The path starts at the first corner's "before" cut point, `radius` back along the left
    // edge from (0,0) toward (0,100) — its y-coordinate grows with the radius (x stays 0, since
    // that edge is vertical).
    const firstY = (d: string) => Number(d.match(/^M[\d.]+,([\d.]+)/)![1]);
    expect(firstY(largeResult)).toBeGreaterThan(firstY(smallResult));
  });

  it("roundCorners with radius 0 is a no-op", async () => {
    const shape = rect();
    const zeroRadius = modifier<Extract<GeometryModifier, { kind: "roundCorners" }>>({ kind: "roundCorners", radius: 0 });
    const result = await applyModifierStack(shape, [zeroRadius]);
    expect(result).toBe(basePathFor(shape));
  });

  it("zigzag replaces straight edges with alternating offsets, staying closed", async () => {
    const shape = rect(100, 100);
    const zig = modifier<Extract<GeometryModifier, { kind: "zigzag" }>>({ kind: "zigzag", amplitude: 10, segmentLength: 20 });
    const result = (await applyModifierStack(shape, [zig]))!;
    const { points, closed } = parseFlatPolygon(result);
    expect(closed).toBe(true);
    // A 100-unit edge cut into 20-unit zigzag segments produces far more vertices than the plain 4-corner rectangle.
    expect(points.length).toBeGreaterThan(8);
  });

  it("chains modifiers in order: roundCorners then zigzag operates on the already-rounded shape, not the raw rectangle", async () => {
    const shape = rect(100, 100);
    const round = modifier<Extract<GeometryModifier, { kind: "roundCorners" }>>({ kind: "roundCorners", radius: 10 });
    const zig = modifier<Extract<GeometryModifier, { kind: "zigzag" }>>({ kind: "zigzag", amplitude: 5, segmentLength: 10 });
    const roundOnly = (await applyModifierStack(shape, [round]))!;
    const roundThenZig = (await applyModifierStack(shape, [round, zig]))!;
    const zigOnly = (await applyModifierStack(shape, [zig]))!;
    expect(roundThenZig).not.toBe(roundOnly);
    expect(roundThenZig).not.toBe(zigOnly);
  });

  it("is non-vacuous: recomputing after the base rectangle's width changes produces a different path", async () => {
    const shape = rect(100, 100);
    const round = modifier<Extract<GeometryModifier, { kind: "roundCorners" }>>({ kind: "roundCorners", radius: 10 });
    const before = await applyModifierStack(shape, [round]);
    const widened = { ...shape, width: 300 } as VectorShape;
    const after = await applyModifierStack(widened, [round]);
    expect(after).not.toBe(before);
  });

  it("a shape kind with no base outline returns null regardless of the stack", async () => {
    const line = createShape("line", 0, 0);
    const zig = modifier<Extract<GeometryModifier, { kind: "zigzag" }>>({ kind: "zigzag", amplitude: 5, segmentLength: 10 });
    expect(await applyModifierStack(line, [zig])).toBeNull();
  });
});
