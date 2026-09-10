import { describe, expect, it } from "vitest";
import { createRasterDocument, layerDocumentPixels, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import move, { pendingBounds, type MoveState } from "./definitions/move";
import type { ToolContext, ToolPointer } from "./types";

/**
 * The owner's own report: shrink a layer with a corner handle, then — without
 * pressing Enter — drag inside the frame to reposition it, and the shrink is
 * gone, back to the original size.
 *
 * Root cause: a scale (or rotate) leaves the session in "described, not
 * resampled" mode (`PendingTransform.live`, see its own doc comment) — the
 * scale exists only in `live.target`, `pending.pixels` itself stays at its
 * original, pre-scale size until commit. `beginMoveDrag` re-materialises
 * `basePixels` from `next.before` (the pristine layer the whole session
 * started from) deliberately, to avoid compounding one drag's resample into
 * the next — right for avoiding that, but the old "move" branch of
 * `applyDragFrame` had no idea `live` existed at all, and built a plain
 * `dx`/`dy` pending from that pristine, un-scaled buffer — silently dropping
 * the still-uncommitted scale the moment a move-drag started.
 */

const WIDTH = 60, HEIGHT = 60;

function solidDocument(): RasterDocumentState {
  const state = createRasterDocument(WIDTH, HEIGHT);
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 10; y < 50; y += 1) for (let x = 10; x < 50; x += 1) {
    const index = (y * WIDTH + x) * 4;
    pixels[index] = 200; pixels[index + 1] = 80; pixels[index + 2] = 40; pixels[index + 3] = 255;
  }
  setLayerPixels(state.layers[0]!, pixels, WIDTH, HEIGHT);
  return state;
}

function pointerAt(x: number, y: number): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 1 };
}

function harness(document: RasterDocumentState) {
  const layer = document.layers.find((item) => item.id === document.activeLayerId)!;
  const box: { state: MoveState } = { state: move.createState!() as MoveState };
  const context = {
    documentId: "test-document", document,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options: { autoSelect: false },
    activeLayer: layer, selection: document.selection, selectedLayers: [layer.id],
    paintTarget: { kind: "pixels", layerId: layer.id },
    get state() { return box.state; },
    setState: (next: MoveState) => { box.state = next; },
    capturePointer: () => {},
    layerPixels: () => layerDocumentPixels(layer, document.width, document.height),
    targetPixels: () => layerDocumentPixels(layer, document.width, document.height),
    schedulePreview: () => {}, schedulePreviewLayers: () => {}, previewWithLayerHidden: () => {},
    commit: async () => {}, commitSelection: async () => {}, commitDocument: async () => {},
    setActiveLayer: () => {}, setSelectedLayers: () => {}, setForegroundColor: () => {},
    setMaskForegroundWhite: () => {}, resetViewportToFit: () => {}, setLastStrokePoint: () => {},
    setCloneSource: () => {}, setCloneOffset: () => {}, previewSpotHealMask: () => {}, previewSelectionBrushMask: () => {},
    scheduleWork: (fn: () => void) => fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<MoveState>;
  return { context, box };
}

describe("Free Transform: scaling, then dragging without committing, keeps the scale", () => {
  it("a corner-handle shrink survives a subsequent move drag", () => {
    const { context, box } = harness(solidDocument());

    // Opens a pending transform the same way clicking the layer with the Move tool does.
    move.onPointerDown!(context, pointerAt(25, 25));
    move.onPointerMove!(context, pointerAt(25, 25));
    move.onGestureEnd!(context, pointerAt(25, 25));
    const opened = box.state.pending!;
    const boundsBefore = pendingBounds(opened, WIDTH, HEIGHT)!;
    expect(boundsBefore.width).toBeCloseTo(40, 0);

    // Shrink from the bottom-right corner by 15px each axis.
    const corner = { x: boundsBefore.x + boundsBefore.width, y: boundsBefore.y + boundsBefore.height };
    move.onPointerDown!(context, pointerAt(corner.x, corner.y));
    move.onPointerMove!(context, pointerAt(corner.x - 15, corner.y - 15));
    move.onGestureEnd!(context, pointerAt(corner.x - 15, corner.y - 15));
    const afterScale = box.state.pending!;
    expect(afterScale.live).toBeDefined();
    const scaledBounds = pendingBounds(afterScale, WIDTH, HEIGHT)!;
    expect(scaledBounds.width).toBeCloseTo(25, 0);
    expect(scaledBounds.height).toBeCloseTo(25, 0);

    // Without pressing Enter: drag from inside the (now smaller) frame to reposition it.
    const inside = { x: scaledBounds.x + scaledBounds.width / 2, y: scaledBounds.y + scaledBounds.height / 2 };
    move.onPointerDown!(context, pointerAt(inside.x, inside.y));
    move.onPointerMove!(context, pointerAt(inside.x + 8, inside.y + 5));
    move.onGestureEnd!(context, pointerAt(inside.x + 8, inside.y + 5));
    const afterMove = box.state.pending!;

    // The scale must still be in effect — this is the bug: it used to reset to the original
    // (pre-scale) size the instant this move-drag started.
    const finalBounds = pendingBounds(afterMove, WIDTH, HEIGHT)!;
    expect(finalBounds.width).toBeCloseTo(25, 0);
    expect(finalBounds.height).toBeCloseTo(25, 0);
    // And it actually moved, by the drag's own delta.
    expect(finalBounds.x).toBeCloseTo(scaledBounds.x + 8, 0);
    expect(finalBounds.y).toBeCloseTo(scaledBounds.y + 5, 0);
  });
});
