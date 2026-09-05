import { describe, expect, it } from "vitest";
import { srgb } from "@vravio/kernel";
import { solidFill } from "./appearance";
import { createShape, createVectorDocument } from "./document";
import { createVectorGroup, groupShapes } from "./group-ops";
import { rotationMatrixAround } from "./matrix";
import { addShape, shapeAt } from "./shape-ops";
import { buildShapeSpatialIndex, shapeAtIndexed, shapesInRect, shapeWorldBoundsIndexed } from "./spatial-index";
import { appendShapeAt } from "./tree";
import type { VectorDocumentState } from "./types";

/** A pseudo-random generator with a fixed seed, so a failure is reproducible
 * — the same reasoning `env-raster`'s own property-style tests use a fixed
 * scatter formula for, rather than `Math.random()`. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDocument(shapeCount: number, seed: number): VectorDocumentState {
  const random = mulberry32(seed);
  const state = createVectorDocument(2000, 2000);
  for (let i = 0; i < shapeCount; i += 1) {
    const kind = random() < 0.5 ? "rectangle" : "ellipse";
    const shape = createShape(kind, random() * 1900, random() * 1900, { fills: [solidFill(srgb(0, 0, 0))], strokes: [], opacity: 1, blendMode: "normal" });
    if (shape.kind === "rectangle" || shape.kind === "ellipse") {
      shape.width = 10 + random() * 150;
      shape.height = 10 + random() * 150;
      if (shape.kind === "rectangle") shape.cornerRadius = random() * Math.min(shape.width, shape.height) / 2;
    }
    if (random() < 0.15) shape.locked = true;
    if (random() < 0.15) shape.visible = false;
    if (random() < 0.1) shape.transform = rotationMatrixAround(random() * 90, shape.x, shape.y);
    addShape(state, shape);
  }
  // Nest a few shapes in a rotated group, so the property test also exercises
  // the ancestor-transform path both shapeAt and shapeAtIndexed share.
  if (shapeCount >= 4) {
    const ids = state.shapes.slice(0, Math.min(3, state.shapes.length)).map((shape) => shape.id);
    const group = groupShapes(state, ids);
    if (group) group.transform = rotationMatrixAround(random() * 45, 1000, 1000);
  }
  return state;
}

describe("shapeAtIndexed agrees with the linear scan shapeAt — the property that guards against the index quietly drifting from the truth", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}: 300 random shapes, 200 random query points`, () => {
      const state = randomDocument(300, seed);
      const index = buildShapeSpatialIndex(state.shapes);
      const random = mulberry32(seed * 97 + 1);

      for (let i = 0; i < 200; i += 1) {
        const x = random() * 2000, y = random() * 2000;
        const linear = shapeAt(state, x, y);
        const indexed = shapeAtIndexed(index, state.shapes, x, y);
        expect(indexed?.id ?? null, `at (${x.toFixed(1)}, ${y.toFixed(1)})`).toBe(linear?.id ?? null);
      }
    });
  }

  it("agrees on the exact edge of a shape, not just its interior", () => {
    const state = createVectorDocument();
    const shape = createShape("rectangle", 100, 100, { fills: [solidFill(srgb(0, 0, 0))], strokes: [], opacity: 1, blendMode: "normal" });
    addShape(state, shape);
    const index = buildShapeSpatialIndex(state.shapes);
    for (const [x, y] of [[100, 100], [260, 100], [100, 200], [260, 200], [180, 150]]) {
      expect(shapeAtIndexed(index, state.shapes, x!, y!)?.id ?? null).toBe(shapeAt(state, x!, y!)?.id ?? null);
    }
  });
});

describe("shapesInRect", () => {
  it("finds shapes whose bounds intersect the query rectangle and excludes ones that do not", () => {
    const state = createVectorDocument();
    const inside = createShape("rectangle", 10, 10);
    const outside = createShape("rectangle", 1000, 1000);
    addShape(state, inside); addShape(state, outside);
    const index = buildShapeSpatialIndex(state.shapes);

    const found = shapesInRect(index, state.shapes, { x: 0, y: 0, width: 300, height: 300 });
    expect(found.map((shape) => shape.id)).toContain(inside.id);
    expect(found.map((shape) => shape.id)).not.toContain(outside.id);
  });

  it("a group's own indexed entry is never returned — it is not hit-testable and shapesInRect only ever indexes leaf shapes", () => {
    const state = createVectorDocument();
    const group = createVectorGroup();
    appendShapeAt(state, group, null);
    const child = createShape("rectangle", 10, 10);
    appendShapeAt(state, child, group.id);
    const index = buildShapeSpatialIndex(state.shapes);

    const found = shapesInRect(index, state.shapes, { x: 0, y: 0, width: 2000, height: 2000 });
    expect(found.map((shape) => shape.id)).not.toContain(group.id);
    expect(found.map((shape) => shape.id)).toContain(child.id);
  });
});

describe("shapeWorldBoundsIndexed", () => {
  it("matches shapeWorldBounds for the same shape — the index caches, it does not compute something different", () => {
    const state = createVectorDocument();
    const shape = createShape("rectangle", 40, 40);
    addShape(state, shape);
    const index = buildShapeSpatialIndex(state.shapes);
    expect(shapeWorldBoundsIndexed(index, shape.id)).toEqual({ x: 40, y: 40, width: 160, height: 100 });
  });

  it("returns undefined for an id the index does not know about", () => {
    const state = createVectorDocument();
    const index = buildShapeSpatialIndex(state.shapes);
    expect(shapeWorldBoundsIndexed(index, "nonexistent")).toBeUndefined();
  });
});
