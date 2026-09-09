import { describe, expect, it } from "vitest";
import { createRasterDocument, layerDocumentPixels, setLayerPixels, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";
import move, { enterQuadTransformMode, pendingBounds, type MoveState, type PendingTransform } from "./definitions/move";
import type { ToolContext, ToolPointer } from "./types";

/**
 * The owner's screenshot-3 report: the free transform's Skew/Distort/Perspective
 * frame ends up crossing itself and the content comes out scrambled.
 *
 * A transform is a function of where its corners are, not of how many separate
 * drags moved them there — so dragging a corner out and back must return the
 * original picture exactly. That invariant is what this file pins, and it is the
 * same one the Warp mode next door already satisfies by construction: warp keeps
 * a fixed `meshOrigin` and resamples it from scratch every frame, never a
 * previous drag's already-warped result.
 */

const WIDTH = 48, HEIGHT = 48;

/** A hard-edged asymmetric block: asymmetric so a mirrored or transposed
 * resample cannot pass by accident, hard-edged so any difference is a real
 * geometric one rather than interpolation noise at a soft rim. */
function blockDocument(): RasterDocumentState {
  const state = createRasterDocument(WIDTH, HEIGHT);
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 12; y < 32; y += 1) for (let x = 10; x < 38; x += 1) {
    const index = (y * WIDTH + x) * 4;
    pixels[index] = x < 24 ? 220 : 40; pixels[index + 1] = y < 20 ? 200 : 60;
    pixels[index + 2] = 120; pixels[index + 3] = 255;
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
    options: { autoSelect: false, transformMode: "distort" },
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
    setCloneSource: () => {}, setCloneOffset: () => {}, previewSpotHealMask: () => {},
    scheduleWork: (fn: () => void) => fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<MoveState>;
  return { context, box };
}

/** Opens a pending transform the way the app does — a move drag — then switches
 * it into quad mode through the same exported entry the workspace's own
 * right-click menu uses. */
function pendingInQuadMode(context: ToolContext<MoveState>, box: { state: MoveState }): { pending: PendingTransform; bounds: RasterRect } {
  move.onPointerDown!(context, pointerAt(24, 20));
  move.onPointerMove!(context, pointerAt(24, 20));
  move.onGestureEnd!(context, pointerAt(24, 20));
  const opened = box.state.pending!;
  const bounds = pendingBounds(opened, WIDTH, HEIGHT)!;
  const pending = enterQuadTransformMode(opened, bounds);
  box.state = { pending, drag: null };
  return { pending, bounds };
}

/** One whole handle drag: press on the handle, move, release. */
function dragHandle(context: ToolContext<MoveState>, from: { x: number; y: number }, to: { x: number; y: number }) {
  move.onPointerDown!(context, pointerAt(from.x, from.y));
  move.onPointerMove!(context, pointerAt(to.x, to.y));
  move.onGestureEnd!(context, pointerAt(to.x, to.y));
}

describe("free transform is a function of its corners, not of how it got there", () => {
  it("returns the original pixels when a distort corner is dragged out and back", () => {
    const { context, box } = harness(blockDocument());
    const { pending, bounds } = pendingInQuadMode(context, box);
    const original = pending.pixels.slice();
    const topLeft = { x: bounds.x, y: bounds.y };

    // Out, released, then back to exactly where it started — two separate
    // drags, the case a single drag can never exercise.
    dragHandle(context, topLeft, { x: topLeft.x + 9, y: topLeft.y + 6 });
    const displaced = box.state.pending!;
    expect(displaced.corners).toBeTruthy();
    expect(displaced.corners![0]).toEqual({ x: topLeft.x + 9, y: topLeft.y + 6 });
    dragHandle(context, { x: topLeft.x + 9, y: topLeft.y + 6 }, topLeft);

    const returned = box.state.pending!;
    expect(returned.corners![0]).toEqual(topLeft);
    // Corners back at the identity rectangle means the resample is the identity
    // map, so the pixels have to be the ones the session started with. Under the
    // double-warp bug the second drag resamples the *first* drag's output, and
    // the picture never comes back.
    const differing = returned.pixels.reduce((count, value, index) => value === original[index] ? count : count + 1, 0);
    expect(differing).toBe(0);
  });

  it("reaches the same picture whether a corner is moved in one drag or two", () => {
    const target = { dx: 12, dy: -8 };

    const one = harness(blockDocument());
    const first = pendingInQuadMode(one.context, one.box);
    const cornerOne = { x: first.bounds.x + first.bounds.width, y: first.bounds.y };
    dragHandle(one.context, cornerOne, { x: cornerOne.x + target.dx, y: cornerOne.y + target.dy });

    const two = harness(blockDocument());
    const second = pendingInQuadMode(two.context, two.box);
    const cornerTwo = { x: second.bounds.x + second.bounds.width, y: second.bounds.y };
    const half = { x: cornerTwo.x + target.dx / 2, y: cornerTwo.y + target.dy / 2 };
    dragHandle(two.context, cornerTwo, half);
    dragHandle(two.context, half, { x: cornerTwo.x + target.dx, y: cornerTwo.y + target.dy });

    expect(two.box.state.pending!.corners).toEqual(one.box.state.pending!.corners);
    // Same corners, same source, so the same picture — resampling twice may not
    // agree bit for bit, but it must not be a different transform. A handful of
    // interpolation-level differences is the whole tolerance here.
    const a = one.box.state.pending!.pixels, b = two.box.state.pending!.pixels;
    let farApart = 0;
    for (let index = 0; index < a.length; index += 1) if (Math.abs(a[index]! - b[index]!) > 24) farApart += 1;
    expect(farApart).toBe(0);
  });
});

describe("scale and rotate handles across separate drags", () => {
  /** Grabs the frame's own handle position, the way a user does, and drags it. */
  function handleAt(bounds: RasterRect, hx: -1 | 0 | 1, hy: -1 | 0 | 1) {
    return { x: bounds.x + ((hx + 1) / 2) * bounds.width, y: bounds.y + ((hy + 1) / 2) * bounds.height };
  }

  it("returns near the original picture when a scale handle is dragged out and back", () => {
    const { context, box } = harness(blockDocument());
    move.onPointerDown!(context, pointerAt(24, 20));
    move.onPointerMove!(context, pointerAt(24, 20));
    move.onGestureEnd!(context, pointerAt(24, 20));
    const opened = box.state.pending!;
    const bounds = pendingBounds(opened, WIDTH, HEIGHT)!;
    const original = opened.pixels.slice();

    const corner = handleAt(bounds, 1, 1);
    dragHandle(context, corner, { x: corner.x + 8, y: corner.y + 6 });
    const grown = pendingBounds(box.state.pending!, WIDTH, HEIGHT)!;
    const grownCorner = handleAt(grown, 1, 1);
    dragHandle(context, grownCorner, { x: grownCorner.x - 8, y: grownCorner.y - 6 });

    // Two resamples of a scale never come back bit for bit — this asks only
    // that the picture is recognisably the same one, which a doubly-applied
    // transform would not be.
    const back = box.state.pending!.pixels;
    let farApart = 0;
    for (let index = 0; index < back.length; index += 1) if (Math.abs(back[index]! - original[index]!) > 64) farApart += 1;
    expect(farApart / (WIDTH * HEIGHT * 4)).toBeLessThan(0.05);
  });
});
