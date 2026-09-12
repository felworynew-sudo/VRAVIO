import { describe, expect, it } from "vitest";
import ellipseMarquee from "./definitions/ellipse-marquee";
import marquee from "./definitions/marquee";
import type { MarqueeState } from "./marquee-selection";
import { createRectangleSelection, type PixelSelection, type RasterDocumentState } from "@vravio/env-raster";
import type { RasterToolDefinition, ToolContext, ToolPointer } from "./types";

/**
 * The owner's own report: holding Shift while dragging a round or square
 * marquee should stretch it 1:1 (a circle, a square) — the *committed*
 * selection already did this (`shapeFrom`, called at `onGestureEnd`, reads
 * Shift/Alt correctly), but the live marching-ants preview shown while
 * still dragging did not, because `Overlay` built its own rectangle with
 * `marqueeRect(...)` and never passed the same `{ square, fromCentre }`
 * options `shapeFrom` does — it stayed an unconstrained rectangle for the
 * whole drag, only snapping to 1:1 on release. Verified here by comparing
 * the *live* Overlay's own shape against what the drag would actually
 * commit, mid-drag, not just at the end.
 */

const WIDTH = 100, HEIGHT = 100;

function pointerAt(x: number, y: number, shiftKey = false, altKey = false): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey, altKey, ctrlKey: false, metaKey: false, button: 0, pressure: 1 };
}

function driveDrag(tool: RasterToolDefinition<MarqueeState>, path: readonly { x: number; y: number; shiftKey?: boolean; altKey?: boolean }[]): { state: MarqueeState; context: ToolContext<MarqueeState> } {
  let state = tool.createState!() as MarqueeState;
  const document: RasterDocumentState = { width: WIDTH, height: HEIGHT } as RasterDocumentState;
  let selection: PixelSelection | null = null;
  const context = {
    documentId: "test-document",
    document,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options: {},
    spaceHeld: false,
    get selection() { return selection; },
    get state() { return state; },
    setState: (next: MarqueeState) => { state = next; },
    capturePointer: () => {},
    commitSelection: async (_before: PixelSelection | null, after: PixelSelection | null) => { selection = after; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<MarqueeState>;

  tool.onPointerDown!(context, pointerAt(path[0]!.x, path[0]!.y, path[0]!.shiftKey, path[0]!.altKey));
  for (const step of path.slice(1)) tool.onPointerMove!(context, pointerAt(step.x, step.y, step.shiftKey, step.altKey));
  return { state, context };
}

describe("marquee/ellipse live preview under Shift (square/circle constrain)", () => {
  it("without Shift, a taller-than-wide drag previews a non-square rectangle", () => {
    const { state, context } = driveDrag(marquee, [{ x: 10, y: 10 }, { x: 30, y: 70 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svg = marquee.Overlay!({ state, document: context.document, context, options: {} } as any) as any;
    const rect = svg.props.children.props.children;
    expect(rect.props.width).toBeCloseTo(20, 0);
    expect(rect.props.height).toBeCloseTo(60, 0);
  });

  it("holding Shift mid-drag squares the *live preview* immediately, not only the eventual commit", () => {
    const { state, context } = driveDrag(marquee, [{ x: 10, y: 10 }, { x: 30, y: 70, shiftKey: true }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svg = marquee.Overlay!({ state, document: context.document, context, options: {} } as any) as any;
    const rect = svg.props.children.props.children;
    // The larger extent (height, 60) wins — the same rule `marqueeCorners` itself documents.
    expect(rect.props.width).toBeCloseTo(rect.props.height, 0);
    expect(rect.props.width).toBeCloseTo(60, 0);
  });

  it("holding Shift on the ellipse tool previews a circle (equal radii) mid-drag", () => {
    const { state, context } = driveDrag(ellipseMarquee, [{ x: 10, y: 10 }, { x: 25, y: 10 }, { x: 25, y: 55, shiftKey: true }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svg = ellipseMarquee.Overlay!({ state, document: context.document, context, options: {} } as any) as any;
    const ellipse = svg.props.children.props.children;
    expect(ellipse.props.rx).toBeCloseTo(ellipse.props.ry, 0);
  });

  it("the live-preview square matches the shape the drag actually commits", () => {
    const { state, context } = driveDrag(marquee, [{ x: 10, y: 10 }, { x: 30, y: 70, shiftKey: true }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svg = marquee.Overlay!({ state, document: context.document, context, options: {} } as any) as any;
    const previewWidth = svg.props.children.props.children.props.width;

    marquee.onGestureEnd!(context, pointerAt(30, 70, true));
    const committed = context.selection!;
    expect(committed.bounds.width).toBeCloseTo(previewWidth, 0);
    expect(committed.bounds.width).toBeCloseTo(committed.bounds.height, 0);
  });
});

/**
 * Dragging from *inside* an existing selection moves it (`onPointerDown`'s `inside` branch) —
 * `translateSelection` walks and reallocates a full document-sized mask, measured live at
 * 10-22ms on a 2000×2000 document, so `onPointerMove` defers it through `context.scheduleWork`
 * instead of calling it on every native pointermove (RasterWorkspace dispatches once per
 * *coalesced* event, several of which land inside one frame — calling this synchronously
 * visibly stuttered the whole tab). Regression coverage for that fix: the drag branch must
 * actually go through `scheduleWork`, and `onGestureEnd` must recompute synchronously from the
 * release point rather than trust a `drag.preview` that a fast pointer-up could outrun.
 */
describe("marquee move-selection drag defers the expensive recompute", () => {
  it("moving an existing selection schedules the recompute instead of doing it inline, and commits the right offset", () => {
    let state = marquee.createState!() as MarqueeState;
    const document: RasterDocumentState = { width: WIDTH, height: HEIGHT } as RasterDocumentState;
    let selection: PixelSelection | null = null;
    let scheduledCount = 0;
    const context = {
      documentId: "test-document",
      document,
      viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
      options: {},
      spaceHeld: false,
      get selection() { return selection; },
      get state() { return state; },
      setState: (next: MarqueeState) => { state = next; },
      capturePointer: () => {},
      commitSelection: async (_before: PixelSelection | null, after: PixelSelection | null) => { selection = after; },
      // The test's own RAF stand-in: runs the callback immediately, same as the project's other
      // tool-contract tests already do (CLAUDE.md's own note — this harness drives gestures
      // synchronously, with no real RAF between frames) — enough to prove the drag branch
      // routes through `scheduleWork` at all and that the resulting math is correct, not to
      // reproduce real coalesced-event timing.
      scheduleWork: (fn: () => void) => { scheduledCount += 1; fn(); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as ToolContext<MarqueeState>;

    // Draw and commit an initial 20x20 selection at (10,10).
    marquee.onPointerDown!(context, pointerAt(10, 10));
    marquee.onPointerMove!(context, pointerAt(30, 30));
    marquee.onGestureEnd!(context, pointerAt(30, 30));
    const before = context.selection!;
    expect(before.bounds).toMatchObject({ x: 10, y: 10, width: 20, height: 20 });

    // Press inside the committed selection and drag it — this must take the "drag" branch, not
    // start a brand-new "draw".
    marquee.onPointerDown!(context, pointerAt(15, 15));
    expect(state.drag).not.toBeNull();
    expect(state.draw).toBeNull();

    // Pressed at (15,15), dragging to (20,25): dx=5, dy=10 — the base (10,10) rect lands at (15,20).
    scheduledCount = 0;
    marquee.onPointerMove!(context, pointerAt(20, 25));
    expect(scheduledCount).toBe(1);
    expect(state.drag!.preview!.bounds).toMatchObject({ x: 15, y: 20, width: 20, height: 20 });

    marquee.onGestureEnd!(context, pointerAt(20, 25));
    const after = context.selection!;
    expect(after.bounds).toMatchObject({ x: 15, y: 20, width: 20, height: 20 });
  });

  it("clears an existing marquee on a click instead of committing a zero-distance move", () => {
    let state = marquee.createState!() as MarqueeState;
    const document: RasterDocumentState = { width: WIDTH, height: HEIGHT } as RasterDocumentState;
    let selection: PixelSelection | null = createRectangleSelection(WIDTH, HEIGHT, 10, 10, 30, 30);
    const context = {
      documentId: "test-document", document,
      viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" }, options: {}, spaceHeld: false,
      get selection() { return selection; }, get state() { return state; },
      setState: (next: MarqueeState) => { state = next; }, capturePointer: () => {},
      commitSelection: async (_before: PixelSelection | null, after: PixelSelection | null) => { selection = after; },
      scheduleWork: (fn: () => void) => fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as ToolContext<MarqueeState>;
    marquee.onPointerDown!(context, pointerAt(15, 15));
    marquee.onGestureEnd!(context, pointerAt(15, 15));
    expect(context.selection).toBeNull();
  });
});
