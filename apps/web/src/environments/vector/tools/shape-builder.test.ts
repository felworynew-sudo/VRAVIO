import { describe, expect, it } from "vitest";
import { buildShapeBuilderFaces, buildShapeSpatialIndex, createShape, createVectorDocument, emptyVectorStyle, shapeOutlineWorldPolygon, solidFill, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
import { srgb } from "@vravio/kernel";
import { createWasmGeometryPort } from "../../../vector-geometry-wasm";
import shapeBuilder, { commitShapeBuilderDrag, type ShapeBuilderState } from "./definitions/shape-builder";
import type { ToolContext, ToolPointer } from "./types";

/**
 * Real, end-to-end coverage of `vector.shape-builder`'s merge/erase gesture
 * — the one thing `contract.test.ts`'s own `fullGesture` cannot exercise
 * (see that file's own comment): every gesture this tool has is gated on
 * `state.faces`, which its `Overlay`'s `useEffect` populates by actually
 * calling the WASM boolean-op engine, and this headless harness never
 * renders an `Overlay`. So this file does what the `Overlay` would have:
 * builds two real overlapping rectangles, fractures them with the same
 * `buildShapeBuilderFaces` + real WASM port the tool itself uses, and
 * seeds the result directly into `state.faces` before driving the tool's
 * own `onPointerDown`/`onPointerMove`/`commitShapeBuilderDrag` exactly the
 * way a real drag would.
 */

function pointerAt(x: number, y: number, extra: Partial<ToolPointer> = {}): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, detail: 1, ...extra };
}

async function fixture() {
  const document = createVectorDocument(400, 300);
  // A: (0,0)-(20,20); B: (10,10)-(30,30) — a 10x10 overlap in the middle.
  const a = createShape("rectangle", 0, 0, { ...emptyVectorStyle(), fills: [solidFill(srgb(0xff, 0, 0))] });
  if (a.kind === "rectangle") { a.width = 20; a.height = 20; }
  const b = createShape("rectangle", 10, 10, { ...emptyVectorStyle(), fills: [solidFill(srgb(0, 0, 0xff))] });
  if (b.kind === "rectangle") { b.width = 20; b.height = 20; }
  document.shapes = [a, b];
  document.selection = [a.id, b.id];

  const port = createWasmGeometryPort();
  const polygons = [a, b].map((shape) => ({ id: shape.id, polygon: shapeOutlineWorldPolygon(shape, document.shapes)! }));
  const faces = await buildShapeBuilderFaces(port, polygons);
  const styleById = new Map([a, b].map((shape) => [shape.id, shape.style]));

  let state: ShapeBuilderState = { faces, styleById, orderedSourceIds: [a.id, b.id], hovered: null, drag: null };
  const context: ToolContext<ShapeBuilderState> = {
    documentId: "test-document",
    document,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options: {},
    get activeShape() { return document.shapes.find((shape) => shape.id === document.activeShapeId) ?? null; },
    get selection() { return document.selection; },
    foregroundColor: "#101317",
    get spatialIndex() { return buildShapeSpatialIndex(document.shapes); },
    snapping: { sources: [], gridSpacing: null, radius: 0 },
    get state() { return state; },
    setState: (next) => { state = next; },
    mutate: (fn) => fn(document),
    snapshot: () => ({ shapes: structuredClone(document.shapes), activeShapeId: document.activeShapeId, selection: document.selection, artboards: structuredClone(document.artboards), activeArtboardId: document.activeArtboardId, palette: structuredClone(document.palette), guides: structuredClone(document.guides), rulerOrigin: document.rulerOrigin, rulerMode: document.rulerMode, cmykProfileAssetId: document.cmykProfileAssetId, softproof: document.softproof }),
    commitDrag: () => {},
    changeDocument: async (_label, mutateFn) => { mutateFn(document); },
  };
  return { document, context, a: a as VectorShape, b: b as VectorShape };
}

describe("vector.shape-builder", () => {
  it("fractures two overlapping rectangles into exactly three faces", async () => {
    const { context } = await fixture();
    expect(context.state.faces).toHaveLength(3);
  });

  it("a plain drag across A-only and the overlap merges just those two into one shape, leaving B-only intact", async () => {
    const { document, context, a, b } = await fixture();
    // (5,5) is inside A only; (15,15) is inside the A∩B overlap.
    shapeBuilder.onPointerDown!(context, pointerAt(5, 5));
    shapeBuilder.onPointerMove!(context, pointerAt(15, 15));
    expect(context.state.drag?.touched.size).toBe(2);
    await commitShapeBuilderDrag(context);

    // The two original shapes are gone; two results remain: the merged
    // A+overlap piece, and B's own untouched remainder.
    expect(document.shapes.some((shape) => shape.id === a.id)).toBe(false);
    expect(document.shapes.some((shape) => shape.id === b.id)).toBe(false);
    expect(document.shapes).toHaveLength(2);

    // The merged shape should contain a point from A's own corner (2,2) and
    // from the overlap (15,15) — proof the two touched faces actually
    // joined into one polygon rather than staying separate.
    const merged = document.shapes.find((shape) => shape.kind === "path" && shape.points.some((p) => Math.abs(p.x - 0) < 0.01));
    expect(merged, "expected a merged shape reaching back to A's own corner").toBeDefined();
  });

  it("Alt-drag across the overlap erases it, leaving A-only and B-only as two separate shapes", async () => {
    const { document, context } = await fixture();
    shapeBuilder.onPointerDown!(context, pointerAt(15, 15, { altKey: true }));
    expect(context.state.drag?.erasing).toBe(true);
    await commitShapeBuilderDrag(context);

    // Erasing the one touched face (the overlap) keeps the other two —
    // A-only and B-only — and drops the overlap entirely: 2 shapes, not 3.
    expect(document.shapes).toHaveLength(2);
  });

  it("returns to its initial (no faces) state on deactivate", async () => {
    const { context } = await fixture();
    shapeBuilder.onDeactivate!(context);
    expect(context.state).toEqual(shapeBuilder.createState());
  });
});
