import { describe, expect, it } from "vitest";
import { createRasterDocument, type RasterDocumentState } from "@vravio/env-raster";
import crop, { type CropState } from "./definitions/crop";
import type { ToolContext, ToolPointer } from "./types";

/**
 * §65.8 — "кроп инструментом нельзя сделать рабочую область больше, чем она есть сейчас". The
 * frame stopped at the canvas edge unless "AI Border Fill" was on; in Photoshop the crop box always
 * reaches past the edge and the fill option only decides what fills the new border.
 */
const pointerAt = (x: number, y: number): ToolPointer => ({ point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 1 });

function drive(options: Record<string, unknown>) {
  const document = createRasterDocument(100, 80);
  let state: CropState = crop.createState!() as CropState;
  const commits: { before: RasterDocumentState; after: RasterDocumentState }[] = [];
  const context = {
    documentId: "doc", document, options, viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    activeLayer: document.layers[0],
    get state() { return state; },
    setState: (next: CropState) => { state = next; },
    capturePointer: () => {},
    scheduleWork: (work: () => void) => work(),
    commitDocument: async (before: RasterDocumentState, after: RasterDocumentState) => { commits.push({ before, after }); },
    resetViewportToFit: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<CropState>;
  return { context, commits, get state() { return state; } };
}

describe("crop: the frame reaches past the canvas", () => {
  it("drags a handle past the edge and grows the canvas with the AI fill off", () => {
    const run = drive({ aiBorderFill: false });
    crop.onPointerDown!(run.context, pointerAt(10, 10));
    crop.onPointerMove!(run.context, pointerAt(90, 70));
    crop.onGestureEnd!(run.context, pointerAt(90, 70));
    expect(run.state.pending?.rect).toEqual({ x: 10, y: 10, width: 80, height: 60 });

    // Bottom-right handle, dragged 60px beyond the right and bottom edges.
    crop.onPointerDown!(run.context, pointerAt(90, 70));
    crop.onPointerMove!(run.context, pointerAt(160, 140));
    crop.onGestureEnd!(run.context, pointerAt(160, 140));
    expect(run.state.pending?.rect).toEqual({ x: 10, y: 10, width: 150, height: 130 });

    crop.onDeactivate!(run.context);
    expect(run.commits).toHaveLength(1);
    expect(run.commits[0]!.after.width).toBe(150);
    expect(run.commits[0]!.after.height).toBe(130);
  });

  it("moves the whole frame past the edge too", () => {
    const run = drive({});
    crop.onPointerDown!(run.context, pointerAt(10, 10));
    crop.onPointerMove!(run.context, pointerAt(60, 50));
    crop.onGestureEnd!(run.context, pointerAt(60, 50));
    crop.onPointerDown!(run.context, pointerAt(30, 30));
    crop.onPointerMove!(run.context, pointerAt(-20, -30));
    crop.onGestureEnd!(run.context, pointerAt(-20, -30));
    expect(run.state.pending?.rect).toEqual({ x: -40, y: -50, width: 50, height: 40 });
  });
});
