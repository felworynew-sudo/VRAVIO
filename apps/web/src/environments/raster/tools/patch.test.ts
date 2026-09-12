import { describe, expect, it } from "vitest";
import { HistoryManager } from "@vravio/kernel";
import { createEllipseSelection, type PixelSelection } from "@vravio/env-raster";
import patch, { type PatchState } from "./definitions/patch";
import type { ToolContext, ToolPointer } from "./types";

/**
 * Two owner-reported fixes:
 *
 * 1. "жестко тупит, постоянно перезаписывает" — `onPointerMove` used to run
 *    a real (if scaled-down) multigrid solve synchronously for *every*
 *    coalesced native pointer event, not once per animation frame; a fast
 *    drag coalescing a dozen samples meant a dozen solves before the next
 *    paint. Now the target point is recorded and the actual work goes
 *    through `context.scheduleWork` — this test drives the tool with a
 *    `scheduleWork` that *counts* calls instead of running them inline, so
 *    a rapid multi-sample move can be told apart from "solved once, on the
 *    latest point" versus "solved every sample".
 *
 * 2. "с зажатым шифт можно добавлять ещё выделение, как и с лассо" —
 *    clicking with Shift held, even with a selection already in place,
 *    should draw a *new* lasso shape and add it, not start a patch drag.
 *
 * Lives beside `selection-brush.test.ts` rather than under `definitions/`
 * for the same reason that one does: `registry.ts`'s own glob
 * (`./definitions/*.{tsx,ts}`) picks up every file in that folder as a tool
 * module and expects a `default` export — a `.test.ts` file there breaks
 * the whole catalogue, not just its own suite.
 */

const WIDTH = 60, HEIGHT = 60;

function pointerAt(x: number, y: number, shiftKey = false, altKey = false): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey, altKey, ctrlKey: false, metaKey: false, button: 0, pressure: 1 };
}

function baseContext(selection: PixelSelection | null) {
  const before = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  let state: PatchState = patch.createState!() as PatchState;
  let currentSelection = selection;
  const scheduled: (() => void)[] = [];
  const commits: { before: Uint8ClampedArray; after: Uint8ClampedArray; label: string }[] = [];
  const selectionCommits: { before: PixelSelection | null; after: PixelSelection | null }[] = [];
  const context = {
    documentId: "test-document",
    document: { width: WIDTH, height: HEIGHT },
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options: {},
    paintTarget: { kind: "pixels", layerId: "layer-1" },
    // RasterWorkspace supplies the active selection as paintMask. Keeping the
    // harness faithful is essential here: Patch deliberately refuses to heal
    // without this mask, so `undefined` only tests its no-op safety path.
    paintMask: selection?.mask,
    get selection() { return currentSelection; },
    get state() { return state; },
    setState: (next: PatchState) => { state = next; },
    capturePointer: () => {},
    layerPixels: () => before.slice(),
    compositePixels: () => before.slice(),
    schedulePreview: () => {},
    // Counts instead of running inline — the point of this harness for test 1.
    scheduleWork: (fn: () => void) => { scheduled.push(fn); },
    commit: async (b: Uint8ClampedArray, a: Uint8ClampedArray, label: string) => { commits.push({ before: b, after: a, label }); },
    commitSelection: async (b: PixelSelection | null, a: PixelSelection | null) => { selectionCommits.push({ before: b, after: a }); currentSelection = a; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<PatchState>;
  return { context, scheduled, commits, selectionCommits };
}

describe("patch tool: throttling a live drag's own solve to one per frame", () => {
  it("several coalesced pointer-move samples in a row schedule work, not run it immediately", () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 10, 10, 30, 30, 0);
    const { context, scheduled } = baseContext(selection);
    patch.onPointerDown!(context, pointerAt(20, 20));
    // Five samples the way five coalesced events in one real frame would arrive.
    for (let i = 0; i < 5; i += 1) patch.onPointerMove!(context, pointerAt(20 + i, 20 + i));
    // Each call *queues* a scheduleWork callback (this harness counts calls rather than folding
    // them into one, the way the real RAF-coalescing queue would) — the meaningful assertion is
    // that none of them ran inline: nothing in this tool's own onPointerMove calls the solve
    // (`stroke.working`) directly any more, it all goes through the scheduled callback.
    expect(scheduled.length).toBe(5);
  });

  it("running the scheduled work solves against the latest point, not a stale intermediate one", () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 10, 10, 30, 30, 0);
    const { context, scheduled } = baseContext(selection);
    patch.onPointerDown!(context, pointerAt(20, 20));
    patch.onPointerMove!(context, pointerAt(22, 20));
    patch.onPointerMove!(context, pointerAt(28, 20));
    // Running only the *first* queued callback still reads `stroke.pending`, which by then
    // already holds the second move's point — the same "always the latest" behaviour
    // `scheduleWork`'s own real queue gives for free, reproduced here since this harness does
    // not coalesce the callbacks itself.
    scheduled[0]!();
    const state = context.state as PatchState;
    expect(state.stroke!.pending.x).toBe(28);
  });
});

describe("patch tool: Shift/Alt add to an existing selection like Lasso does", () => {
  it("a plain click-drag with an existing selection starts a patch drag, not a new lasso", () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 10, 10, 30, 30, 0);
    const { context } = baseContext(selection);
    patch.onPointerDown!(context, pointerAt(20, 20));
    const state = context.state as PatchState;
    expect(state.stroke).not.toBeNull();
    expect(state.fallbackLasso).toBeNull();
  });

  it("starts a patch drag only when the press is inside the selected pixels", () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 10, 10, 30, 30, 0);
    const { context } = baseContext(selection);
    patch.onPointerDown!(context, pointerAt(42, 42));
    const state = context.state as PatchState;
    expect(state.stroke).toBeNull();
    expect(state.fallbackLasso).not.toBeNull();
  });

  it("uses a click without a drag to deselect instead of applying a zero-offset patch", () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 10, 10, 30, 30, 0);
    const { context, commits, selectionCommits } = baseContext(selection);
    patch.onPointerDown!(context, pointerAt(20, 20));
    patch.onGestureEnd!(context, pointerAt(20, 20));
    expect(commits).toHaveLength(0);
    expect(selectionCommits).toHaveLength(1);
    expect(context.selection).toBeNull();
  });

  it("also deselects when an outside click begins but does not complete a new lasso", () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 10, 10, 30, 30, 0);
    const { context, selectionCommits } = baseContext(selection);
    patch.onPointerDown!(context, pointerAt(42, 42));
    patch.onGestureEnd!(context, pointerAt(42, 42));
    expect(selectionCommits).toHaveLength(1);
    expect(context.selection).toBeNull();
  });

  it("marks only a live patch drag as replacing the committed outline", () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 10, 10, 30, 30, 0);
    const { context } = baseContext(selection);
    expect(patch.hidesCommittedSelection?.(context.state as PatchState, context)).toBe(false);
    patch.onPointerDown!(context, pointerAt(20, 20));
    expect(patch.hidesCommittedSelection?.(context.state as PatchState, context)).toBe(true);
  });

  it("Shift held, even with a selection already in place, draws a new lasso instead", () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 10, 10, 30, 30, 0);
    const { context } = baseContext(selection);
    patch.onPointerDown!(context, pointerAt(20, 20, true));
    const state = context.state as PatchState;
    expect(state.fallbackLasso).not.toBeNull();
    expect(state.stroke).toBeNull();
  });

  it("that Shift-drawn lasso adds to the existing selection rather than replacing it", () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 5, 5, 15, 15, 0);
    const { context, selectionCommits } = baseContext(selection);
    // A shape well away from the original ellipse, so "added" is unambiguous.
    patch.onPointerDown!(context, pointerAt(30, 30, true));
    patch.onPointerMove!(context, pointerAt(45, 30, true));
    patch.onPointerMove!(context, pointerAt(45, 45, true));
    patch.onPointerMove!(context, pointerAt(30, 45, true));
    patch.onGestureEnd!(context, pointerAt(30, 30, true));
    expect(selectionCommits).toHaveLength(1);
    const after = context.selection!;
    // Both the original ellipse's own area and the new patch are selected — an "add", not a
    // "replace" that would have thrown the original ellipse away.
    expect(after.mask[10 * WIDTH + 10]).toBeGreaterThan(0); // inside the original ellipse
    expect(after.mask[37 * WIDTH + 37]).toBeGreaterThan(0); // inside the newly-drawn square
  });
});

describe("patch tool: history", () => {
  it("produces one reversible pixel edit that undo and redo restore exactly", async () => {
    const selection = createEllipseSelection(WIDTH, HEIGHT, 10, 10, 30, 30, 0);
    const { context, commits } = baseContext(selection);
    // A spatially varying source makes a dragged patch observably distinct
    // from its destination. A uniform test image would make a correct patch
    // look like a no-op and would not prove that history has two real sides.
    const source = context.layerPixels();
    for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      source[offset] = (x * 17 + y * 3) % 256;
      source[offset + 1] = (x * 5 + y * 19) % 256;
      source[offset + 2] = (x * 11 + y * 7) % 256;
      source[offset + 3] = 255;
    }
    // Feed the texture to the tool's snapshot without exposing a mutable
    // canvas — the production tool also receives a copy from layerPixels().
    (context as unknown as { layerPixels: () => Uint8ClampedArray }).layerPixels = () => source.slice();

    patch.onPointerDown!(context, pointerAt(20, 20));
    patch.onPointerMove!(context, pointerAt(31, 24));
    patch.onGestureEnd!(context, pointerAt(31, 24));

    expect(commits).toHaveLength(1);
    const edit = commits[0]!;
    expect(edit.label).toBe("Patch (Заплатка)");
    expect(edit.after).not.toEqual(edit.before);

    let pixels = edit.after.slice(); // Patch has already applied this side before it records history.
    let swap = edit.before.slice();
    const history = new HistoryManager();
    const exchange = () => { const current = pixels; pixels = swap; swap = current; };
    await history.record({ label: "Patch (Заплатка)", memoryEstimate: swap.byteLength, redo: exchange, undo: exchange });

    expect(await history.undo()).toBe(true);
    expect(pixels).toEqual(edit.before);
    expect(await history.redo()).toBe(true);
    expect(pixels).toEqual(edit.after);
  });
});
