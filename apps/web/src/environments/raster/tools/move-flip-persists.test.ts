import { describe, expect, it } from "vitest";
import { createRasterDocument, layerDocumentPixels, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import move, { pendingBounds, startPendingTransform, type MoveState } from "./definitions/move";
import { quickFlipPending } from "./transform-quick-rotate";
import type { ToolContext, ToolPointer } from "./types";

/**
 * The owner's own report: flip the layer with the transform bar's button, then start moving or
 * rotating it, and "он снова перевернётся обратно" — the flip silently undoes itself.
 *
 * Root cause was in the types, not the arithmetic: `TransformSession` — what a drag carries
 * through a gesture — had only `source`, `target` and `rotation`, while `PendingTransform.live`
 * additionally had `flipX`/`flipY`. `sessionFor` hands `pending.live` back as a
 * `TransformSession`, so every rebuilt frame (`live: { source, target, rotation }`) dropped the
 * mirror terms on the floor. Nothing failed, nothing warned: the flip was simply gone one
 * gesture later. The two are one type now.
 *
 * This test drives the real tool, through the same `quickFlipPending` the bar button calls, and
 * fails if any of the three rebuild paths — scale, rotate, move — loses the mirror again.
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

describe("Free Transform: a flip survives the next gesture", () => {
  // Edit ▸ Free Transform (Ctrl+T) — the state the owner is in when the transform bar, and so its
  // flip buttons, are on screen at all. A session stays open across gestures; a plain move would
  // commit on pointer-up and there would be no second gesture to lose anything during.
  const openTransform = () => {
    const { context, box } = harness(solidDocument());
    startPendingTransform(context);
    return { context, box };
  };

  /** Flips the open transform the way the contextual bar's own button does. */
  const flip = (box: { state: MoveState }, axis: "x" | "y") => {
    const next = quickFlipPending(box.state.pending!, WIDTH, HEIGHT, axis)!;
    expect(next).toBeTruthy();
    box.state = { ...box.state, pending: next, drag: null };
    return next;
  };

  it("keeps the mirror through a move drag", () => {
    const { context, box } = openTransform();
    flip(box, "x");
    expect(box.state.pending!.live?.flipX).toBe(true);

    const bounds = pendingBounds(box.state.pending!, WIDTH, HEIGHT)!;
    const inside = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    move.onPointerDown!(context, pointerAt(inside.x, inside.y));
    move.onPointerMove!(context, pointerAt(inside.x + 7, inside.y + 4));
    move.onGestureEnd!(context, pointerAt(inside.x + 7, inside.y + 4));

    expect(box.state.pending!.live?.flipX).toBe(true);
    const moved = pendingBounds(box.state.pending!, WIDTH, HEIGHT)!;
    expect(moved.x).toBeCloseTo(bounds.x + 7, 0);
  });

  it("keeps the mirror through a rotate drag, and the angle through a flip", () => {
    const { context, box } = openTransform();
    flip(box, "y");
    expect(box.state.pending!.live?.flipY).toBe(true);

    // Outside the frame rotates (see `findRotateCorner`).
    const bounds = pendingBounds(box.state.pending!, WIDTH, HEIGHT)!;
    const corner = { x: bounds.x + bounds.width + 20, y: bounds.y + bounds.height + 20 };
    move.onPointerDown!(context, pointerAt(corner.x, corner.y));
    move.onPointerMove!(context, pointerAt(corner.x + 14, corner.y - 14));
    move.onGestureEnd!(context, pointerAt(corner.x + 14, corner.y - 14));

    const rotated = box.state.pending!;
    expect(rotated.live?.flipY).toBe(true);
    expect(Math.abs(rotated.rotation)).toBeGreaterThan(0);

    // And the other direction: flipping after a rotation keeps the angle.
    const flipped = flip(box, "x");
    expect(flipped.live?.flipX).toBe(true);
    expect(flipped.live?.flipY).toBe(true);
    expect(flipped.live?.rotation).toBeCloseTo(rotated.rotation, 5);
  });

  it("keeps the mirror through a scale drag", () => {
    const { context, box } = openTransform();
    flip(box, "x");

    const bounds = pendingBounds(box.state.pending!, WIDTH, HEIGHT)!;
    const corner = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
    move.onPointerDown!(context, pointerAt(corner.x, corner.y));
    move.onPointerMove!(context, pointerAt(corner.x - 12, corner.y - 12));
    move.onGestureEnd!(context, pointerAt(corner.x - 12, corner.y - 12));

    expect(box.state.pending!.live?.flipX).toBe(true);
    expect(pendingBounds(box.state.pending!, WIDTH, HEIGHT)!.width).toBeCloseTo(28, 0);
  });

  it("flipping twice is not flipped", () => {
    const { box } = openTransform();
    flip(box, "x");
    flip(box, "x");
    expect(box.state.pending!.live?.flipX).toBe(false);
  });
});
