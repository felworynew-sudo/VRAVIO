import { describe, expect, it } from "vitest";
import { createVectorDocument, buildShapeSpatialIndex, type VectorDocumentState } from "@vravio/env-vector";
import text, { type VectorTextState } from "./definitions/text";
import type { ToolContext, ToolPointer } from "./types";

/**
 * The owner's "текст в растре работает во много раз лучше чем в векторе", pinned at the point
 * where it was actually failing.
 *
 * A press used to open the editing draft immediately. The browser then applies the press's own
 * default focus to the canvas underneath, the freshly focused `<textarea>` blurs, and blur ends
 * the edit — with nothing typed, which removes the shape. Live, the Type tool created a text
 * object and deleted it inside one click, so clicking on the canvas did visibly nothing at all.
 *
 * Raster's Type tool opens its draft in `onGestureEnd`, after the press is over, and has always
 * worked. These tests hold the vector one to the same sequence.
 */

function harness() {
  const document = createVectorDocument(800, 600) as VectorDocumentState;
  const box: { state: VectorTextState } = { state: text.createState!() as VectorTextState };
  const context = {
    documentId: "doc", document,
    viewport: { mode: "custom", zoom: 1, panX: 0, panY: 0, rotation: 0 },
    workspaceSize: { width: 800, height: 600 }, stageBounds: { x: 0, y: 0, width: 800, height: 600 },
    options: { fontSize: 48 },
    activeShape: null, selection: [], foregroundColor: "#000000",
    get spatialIndex() { return buildShapeSpatialIndex(document.shapes); },
    snapping: { smartGuides: false, snapToGrid: false },
    get state() { return box.state; },
    setState: (next: VectorTextState) => { box.state = next; },
    mutate: (fn: (state: VectorDocumentState) => void) => { fn(document); return 1; },
    snapshot: () => document,
    commitDrag: () => {},
    changeDocument: (_label: string, fn: (state: VectorDocumentState) => boolean) => { fn(document); return Promise.resolve(); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<VectorTextState>;
  return { context, box, document };
}

const at = (x: number, y: number): ToolPointer => ({
  point: { x, y }, screenX: x, screenY: y, pointerId: 1,
  shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, detail: 1,
});

describe("the vector Type tool", () => {
  it("creates nothing until the press is over", () => {
    // The specific fault: pressing must not yet put a shape in the document, because the editor
    // that shape exists for cannot hold focus while the same press is still being handled.
    const { context, box, document } = harness();
    text.onPointerDown!(context, at(100, 100));
    expect(document.shapes).toHaveLength(0);
    expect(box.state.draft).toBeNull();

    text.onGestureEnd!(context, at(100, 100));
    expect(document.shapes).toHaveLength(1);
    expect(box.state.draft?.created).toBe(true);
  });

  it("makes point text from a click and area text from a drag", () => {
    // Illustrator's and Inkscape's split, and the one raster's own Type tool already makes.
    const clicked = harness();
    text.onPointerDown!(clicked.context, at(100, 100));
    text.onGestureEnd!(clicked.context, at(100, 100));
    const point = clicked.document.shapes[0]!;
    expect(point.kind === "text" && point.frameWidth).toBeNull();

    const dragged = harness();
    text.onPointerDown!(dragged.context, at(100, 100));
    text.onPointerMove!(dragged.context, at(340, 180));
    text.onGestureEnd!(dragged.context, at(340, 180));
    const area = dragged.document.shapes[0]!;
    expect(area.kind === "text" && area.frameWidth).toBe(240);
    // The drag's rectangle is the frame, so the baseline sits a line below its top edge rather
    // than wherever the press happened to land.
    expect(area.kind === "text" && area.y).toBe(148);
  });

  it("takes back a text object nobody typed into", () => {
    const { context, document } = harness();
    text.onPointerDown!(context, at(100, 100));
    text.onGestureEnd!(context, at(100, 100));
    expect(document.shapes).toHaveLength(1);
    text.onDeactivate!(context);
    expect(document.shapes).toHaveLength(0);
  });

  it("keeps what was typed, and reopens it on the next click", () => {
    const { context, box, document } = harness();
    text.onPointerDown!(context, at(100, 100));
    text.onGestureEnd!(context, at(100, 100));
    const shapeId = box.state.draft!.shapeId;
    // Standing in for the textarea, which lives in the Overlay this harness does not render.
    box.state = { gesture: null, draft: { ...box.state.draft!, value: "Привет" } };
    context.mutate((state) => {
      const shape = state.shapes.find((item) => item.id === shapeId);
      if (shape?.kind === "text") shape.value = "Привет";
    });
    text.onDeactivate!(context);
    expect(document.shapes).toHaveLength(1);

    text.onPointerDown!(context, at(110, 90));
    text.onGestureEnd!(context, at(110, 90));
    expect(box.state.draft?.created).toBe(false);
    expect(box.state.draft?.value).toBe("Привет");
    expect(document.shapes).toHaveLength(1);
  });
});
