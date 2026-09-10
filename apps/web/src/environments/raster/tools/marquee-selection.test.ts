import { describe, expect, it } from "vitest";
import ellipseMarquee from "./definitions/ellipse-marquee";
import marquee from "./definitions/marquee";
import type { MarqueeState } from "./marquee-selection";
import type { PixelSelection, RasterDocumentState } from "@vravio/env-raster";
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
