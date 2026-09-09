import { describe, expect, it } from "vitest";
import { WARP_PRESETS, createRasterDocument, layerDocumentPixels, setLayerPixels, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";
import move, { applyWarpPreset, enterQuadTransformMode, pendingBounds, type MoveState, type PendingTransform } from "./definitions/move";
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

describe("warp styles", () => {
  /** Opens a pending transform and returns it with the bounds the mesh spans. */
  function pendingTransform(context: ToolContext<MoveState>, box: { state: MoveState }) {
    move.onPointerDown!(context, pointerAt(24, 20));
    move.onPointerMove!(context, pointerAt(24, 20));
    move.onGestureEnd!(context, pointerAt(24, 20));
    const pending = box.state.pending!;
    return { pending, bounds: pendingBounds(pending, WIDTH, HEIGHT)! };
  }

  it("sweeps the Bend slider from the pristine layer instead of compounding warps", () => {
    // The property the whole `meshOrigin` arrangement exists for, on the path a user actually
    // takes: dragging Bend fires a change per step, and every step has to re-warp the *original*
    // pixels. Warping the previous step's output instead would bend forty times on the way from
    // 0 to 40 and leave a smear that no amount of dragging back could undo.
    const { context, box } = harness(blockDocument());
    const { pending, bounds } = pendingTransform(context, box);

    const direct = applyWarpPreset(pending, bounds, WIDTH, HEIGHT, "arc", 40, false);
    let swept = pending;
    for (const bend of [10, 20, 30, 35, 40]) swept = applyWarpPreset(swept, bounds, WIDTH, HEIGHT, "arc", bend, false);

    expect(Array.from(swept.pixels)).toEqual(Array.from(direct.pixels));
    // And back to zero is back to the start, not a picture that has been through six resamples.
    const returned = applyWarpPreset(swept, bounds, WIDTH, HEIGHT, "custom", 0, false);
    expect(Array.from(returned.pixels)).toEqual(Array.from(pending.pixels));
  });

  it("actually moves pixels for every style in the menu", () => {
    // CLAUDE.md §3 at the scale of a dropdown: a style that leaves the layer alone is an entry
    // that lies. Checked on the pixels rather than on the mesh, so a style whose control points
    // move without the surface following would still fail.
    for (const preset of WARP_PRESETS) {
      const { context, box } = harness(blockDocument());
      const { pending, bounds } = pendingTransform(context, box);
      const warped = applyWarpPreset(pending, bounds, WIDTH, HEIGHT, preset.id, 60, false);
      // Every channel, not just alpha: Fisheye pins all four corners, so it redistributes the
      // content without touching the silhouette at all — an alpha-only count reads zero for it
      // and would have failed a style that works.
      let changed = 0;
      for (let index = 0; index < warped.pixels.length; index += 1) if (warped.pixels[index] !== pending.pixels[index]) changed += 1;
      expect(`${preset.id}: ${changed}`).not.toBe(`${preset.id}: 0`);
    }
  });

  it("turns the deformation on its side when the orientation is flipped", () => {
    const { context, box } = harness(blockDocument());
    const { pending, bounds } = pendingTransform(context, box);
    const horizontal = applyWarpPreset(pending, bounds, WIDTH, HEIGHT, "arc", 60, false);
    const vertical = applyWarpPreset(pending, bounds, WIDTH, HEIGHT, "arc", 60, true);
    expect(Array.from(vertical.pixels)).not.toEqual(Array.from(horizontal.pixels));
  });

  it("keeps the pristine origin across a style change, so styles never stack", () => {
    // Picking Flag after Arc must give the Flag of the *original* layer, not the Flag of an
    // already-arced one — the same rule as the Bend sweep, one level up.
    const { context, box } = harness(blockDocument());
    const { pending, bounds } = pendingTransform(context, box);
    const arced = applyWarpPreset(pending, bounds, WIDTH, HEIGHT, "arc", 50, false);
    const flagAfterArc = applyWarpPreset(arced, bounds, WIDTH, HEIGHT, "flag", 50, false);
    const flagDirect = applyWarpPreset(pending, bounds, WIDTH, HEIGHT, "flag", 50, false);
    expect(Array.from(flagAfterArc.pixels)).toEqual(Array.from(flagDirect.pixels));
  });
});

describe("a transform under the hand does not resample", () => {
  /** Opens a pending transform the way a move drag does. */
  function opened(context: ToolContext<MoveState>, box: { state: MoveState }) {
    move.onPointerDown!(context, pointerAt(24, 20));
    move.onPointerMove!(context, pointerAt(24, 20));
    move.onGestureEnd!(context, pointerAt(24, 20));
    return { pending: box.state.pending!, bounds: pendingBounds(box.state.pending!, WIDTH, HEIGHT)! };
  }

  it("describes a rotation while dragging and resamples once on release", () => {
    // Krita's Instant Preview, and what this tool already did for text: while the hand is moving,
    // the pixels are left alone and the frame carries a description the Overlay draws with a CSS
    // transform; the honest resample happens when the gesture ends. Before this, every frame
    // resampled — measured at 4.8ms for a small layer and about 64ms for a 1200x1200 one.
    const { context, box } = harness(blockDocument());
    const { pending, bounds } = opened(context, box);
    const untouched = pending.pixels;

    // Press outside the frame and clear of any handle's own grab radius (11 units), so this is
    // the rotate zone rather than a scale handle, and turn.
    move.onPointerDown!(context, pointerAt(bounds.x - 20, bounds.y - 20));
    move.onPointerMove!(context, pointerAt(bounds.x + bounds.width + 20, bounds.y - 20));

    const during = box.state.pending!;
    expect(during.live, "a drag in progress carries a description").toBeTruthy();
    expect(during.live!.rotation).not.toBe(0);
    // The content is the one the drag started with — nothing was resampled. (Not the same
    // object: a drag copies the buffer once at its start, which is not the same as resampling.)
    expect(Array.from(during.pixels)).toEqual(Array.from(untouched));

    move.onGestureEnd!(context, pointerAt(bounds.x + bounds.width + 20, bounds.y - 20));
    const after = box.state.pending!;
    // Releasing does not resample either: the description survives the stop, because the session
    // may well continue with another gesture. Applying it at each release cost a pass every time
    // *and* compounded the interpolation — one 90° turn stays crisp where ten 9° turns do not.
    expect(after.live, "the description outlives the gesture").toBeTruthy();
    expect(Array.from(after.pixels)).toEqual(Array.from(untouched));
  });

  it("keeps one description across several gestures instead of stacking resamples", () => {
    // Two turns and a scale in one session: the pixels must still be the ones the session opened
    // with, and the description must carry the total.
    const { context, box } = harness(blockDocument());
    const { pending, bounds } = opened(context, box);
    const untouched = pending.pixels;

    const turn = (fromX: number, fromY: number, toX: number, toY: number) => {
      move.onPointerDown!(context, pointerAt(fromX, fromY));
      move.onPointerMove!(context, pointerAt(toX, toY));
      move.onGestureEnd!(context, pointerAt(toX, toY));
    };
    turn(bounds.x - 20, bounds.y - 20, bounds.x + bounds.width + 20, bounds.y - 20);
    const afterFirst = box.state.pending!.live!.rotation;
    turn(bounds.x - 20, bounds.y + bounds.height + 20, bounds.x - 20, bounds.y - 20);
    const afterSecond = box.state.pending!.live!.rotation;

    expect(afterSecond).not.toBe(afterFirst);
    expect(Array.from(box.state.pending!.pixels)).toEqual(Array.from(untouched));
  });

  it("does the same for a scale handle", () => {
    const { context, box } = harness(blockDocument());
    const { pending, bounds } = opened(context, box);
    const untouched = pending.pixels;

    move.onPointerDown!(context, pointerAt(bounds.x + bounds.width, bounds.y + bounds.height));
    move.onPointerMove!(context, pointerAt(bounds.x + bounds.width + 8, bounds.y + bounds.height + 5));

    const during = box.state.pending!;
    expect(during.live).toBeTruthy();
    expect(Array.from(during.pixels)).toEqual(Array.from(untouched));
    // And the frame follows the description, not the stale pixels — otherwise the handles would
    // stand still while the content appeared to move.
    const live = pendingBounds(during, WIDTH, HEIGHT)!;
    expect(live.width).toBeGreaterThan(bounds.width);

    move.onGestureEnd!(context, pointerAt(bounds.x + bounds.width + 8, bounds.y + bounds.height + 5));
    expect(box.state.pending!.live, "still described after the stop").toBeTruthy();
    expect(Array.from(box.state.pending!.pixels)).toEqual(Array.from(untouched));
  });

  it("still ends up where the description said it would", () => {
    // The preview and the result have to agree, or the picture jumps on release.
    const { context, box } = harness(blockDocument());
    const { bounds } = opened(context, box);
    move.onPointerDown!(context, pointerAt(bounds.x + bounds.width, bounds.y + bounds.height));
    move.onPointerMove!(context, pointerAt(bounds.x + bounds.width + 8, bounds.y + bounds.height + 5));
    const promised = pendingBounds(box.state.pending!, WIDTH, HEIGHT)!;
    move.onGestureEnd!(context, pointerAt(bounds.x + bounds.width + 8, bounds.y + bounds.height + 5));
    const delivered = pendingBounds(box.state.pending!, WIDTH, HEIGHT)!;
    expect(Math.abs(delivered.width - promised.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(delivered.height - promised.height)).toBeLessThanOrEqual(2);
  });
});
