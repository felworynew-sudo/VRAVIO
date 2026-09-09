import { describe, expect, it, vi } from "vitest";
import { buildShapeSpatialIndex, createVectorDocument, type VectorDocumentState } from "@vravio/env-vector";
import artboard from "./definitions/artboard";
import type { ToolContext, ToolPointer } from "./types";

/**
 * The owner's "простой клик в сторону вызывает окошко с вводом параметров" — and why it did
 * nothing on screen.
 *
 * Whether a press-and-release was a click or a drag was measured in *document* units, two of
 * them. At a fit-to-window 18% zoom two document units is a third of a screen pixel, so every
 * ordinary click read as a drag: instead of asking for a size, the tool committed the 0x0
 * placeholder its press had created. The question "did the hand move" belongs in screen space,
 * where the hand is.
 *
 * Read through `commitDrag` rather than by mocking the dialog: the drag path commits, the click
 * path hands over to the size dialog and commits only once that answers. (A module mock would
 * also be the wrong instrument here — the suite runs with `--no-isolate`, so whichever file
 * imported the tool first decides which copy of the dialog module everyone gets.)
 */

type ArtboardState = NonNullable<ReturnType<NonNullable<typeof artboard.createState>>>;

function harness(zoom: number) {
  const document = createVectorDocument(1920, 1080) as VectorDocumentState;
  const box = { state: artboard.createState!() };
  const commitDrag = vi.fn();
  const context = {
    documentId: "doc", document,
    viewport: { mode: "custom", zoom, panX: 0, panY: 0, rotation: 0 },
    workspaceSize: { width: 800, height: 600 }, stageBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    options: {}, activeShape: null, selection: [], foregroundColor: "#000000",
    get spatialIndex() { return buildShapeSpatialIndex(document.shapes); },
    snapping: { smartGuides: false, snapToGrid: false },
    get state() { return box.state; },
    setState: (next: unknown) => { box.state = next as ArtboardState; },
    mutate: (fn: (state: VectorDocumentState) => void) => { fn(document); return 1; },
    snapshot: () => document,
    commitDrag,
    changeDocument: (_label: string, fn: (state: VectorDocumentState) => boolean) => { fn(document); return Promise.resolve(); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<ArtboardState>;
  return { context, document, commitDrag };
}

const at = (x: number, y: number): ToolPointer => ({
  point: { x, y }, screenX: x, screenY: y, pointerId: 1,
  shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, detail: 1,
});

describe("the Artboard tool's click and drag", () => {
  it("treats a barely-moved pointer as a click, even zoomed far out", () => {
    // 18% is what "fit in window" gives a 1920x1080 document in a normal panel, and it is where
    // this was failing: three document units of travel is half a screen pixel there.
    const { context, commitDrag } = harness(0.18);
    artboard.onPointerDown!(context, at(500, 500));
    artboard.onGestureEnd!(context, at(503, 501));
    expect(commitDrag).not.toHaveBeenCalled();
  });

  it("treats a real drag as a drag and keeps what was dragged", () => {
    const { context, document, commitDrag } = harness(1);
    artboard.onPointerDown!(context, at(100, 100));
    artboard.onPointerMove!(context, at(400, 300));
    artboard.onGestureEnd!(context, at(400, 300));
    expect(commitDrag).toHaveBeenCalledTimes(1);
    expect(document.artboards).toHaveLength(1);
    expect([document.artboards[0]!.width, document.artboards[0]!.height]).toEqual([300, 200]);
  });

  it("still calls a small drag a drag when the canvas is zoomed in", () => {
    // The mirror of the first case: at 800% those same three document units are 24 screen
    // pixels, which is a deliberate movement and must size the artboard rather than open a
    // dialog. A screen-space threshold is the only one that gets both ends right.
    const { context, commitDrag } = harness(8);
    artboard.onPointerDown!(context, at(500, 500));
    artboard.onPointerMove!(context, at(503, 501));
    artboard.onGestureEnd!(context, at(503, 501));
    expect(commitDrag).toHaveBeenCalledTimes(1);
  });

  it("moves an artboard without resizing it, and resizes it without moving its far corner", () => {
    // The two other gestures the same tool owns, on the workflow a person actually runs: draw
    // one, pull its bottom-right handle, then drag it somewhere else.
    const { context, document } = harness(1);
    artboard.onPointerDown!(context, at(100, 100));
    artboard.onPointerMove!(context, at(400, 300));
    artboard.onGestureEnd!(context, at(400, 300));

    artboard.onPointerDown!(context, at(400, 300));
    artboard.onPointerMove!(context, at(500, 400));
    artboard.onGestureEnd!(context, at(500, 400));
    const resized = document.artboards[0]!;
    expect([resized.x, resized.y, resized.width, resized.height]).toEqual([100, 100, 400, 300]);

    artboard.onPointerDown!(context, at(300, 200));
    artboard.onPointerMove!(context, at(340, 260));
    artboard.onGestureEnd!(context, at(340, 260));
    const moved = document.artboards[0]!;
    expect([moved.x, moved.y, moved.width, moved.height]).toEqual([140, 160, 400, 300]);
  });
});
