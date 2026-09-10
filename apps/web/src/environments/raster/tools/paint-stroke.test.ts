import { describe, expect, it } from "vitest";
import brush from "./definitions/brush";
import type { PaintStrokeState } from "./paint-stroke";
import type { PaintTarget, ToolContext, ToolPointer } from "./types";

/**
 * Photoshop's own Shift-while-dragging habit, ported to a freehand stroke:
 * hold Shift partway through a drag and the brush snaps to a straight
 * horizontal or vertical line from wherever it was at that instant. Driven
 * directly against the tool function, the same reasoning
 * `selection-brush.test.ts` already gives for why: this codebase's own
 * Browser-pane drive cannot carry a held modifier through a synthetic drag.
 */

const WIDTH = 60, HEIGHT = 60;

function pointerAt(x: number, y: number, shiftKey = false): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 1 };
}

interface Recorded {
  state: PaintStrokeState;
  working: Uint8ClampedArray;
  commits: { before: Uint8ClampedArray; after: Uint8ClampedArray }[];
}

function driveBrush(path: readonly { x: number; y: number; shiftKey?: boolean }[]): Recorded {
  const before = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const recorded: Recorded = { state: brush.createState!() as PaintStrokeState, working: before, commits: [] };
  const paintTarget: PaintTarget = { kind: "pixels", layerId: "layer-1" };
  const context = {
    documentId: "test-document",
    document: { width: WIDTH, height: HEIGHT },
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options: { size: 10, hardness: 100, opacity: 100, flow: 100, spacing: 12, roundness: 100 },
    get state() { return recorded.state; },
    setState: (next: PaintStrokeState) => { recorded.state = next; },
    capturePointer: () => {},
    paintTarget,
    paintColor: "#000000",
    paintMask: undefined,
    targetPixels: () => before.slice(),
    schedulePreview: (pixels: Uint8ClampedArray) => { recorded.working = pixels; },
    lastStrokePoint: null,
    setLastStrokePoint: () => {},
    commit: async (b: Uint8ClampedArray, a: Uint8ClampedArray) => { recorded.commits.push({ before: b, after: a }); recorded.working = a; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<PaintStrokeState>;

  brush.onPointerDown!(context, pointerAt(path[0]!.x, path[0]!.y, path[0]!.shiftKey));
  for (const step of path.slice(1)) brush.onPointerMove!(context, pointerAt(step.x, step.y, step.shiftKey));
  const last = path[path.length - 1]!;
  brush.onGestureEnd!(context, pointerAt(last.x, last.y, last.shiftKey));
  return recorded;
}

/** The horizontal band (one row's worth, around `y`) a stroke painted into, as a bounding
 *  x-range — used to confirm a locked stroke stayed on one row instead of drifting. */
function paintedRowSpread(pixels: Uint8ClampedArray, y: number): { minX: number; maxX: number } {
  let minX = Infinity, maxX = -Infinity;
  for (let x = 0; x < WIDTH; x += 1) {
    if (pixels[(y * WIDTH + x) * 4 + 3]! > 0) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  }
  return { minX, maxX };
}

function paintedRows(pixels: Uint8ClampedArray): number[] {
  const rows: number[] = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    let any = false;
    for (let x = 0; x < WIDTH; x += 1) if (pixels[(y * WIDTH + x) * 4 + 3]! > 0) { any = true; break; }
    if (any) rows.push(y);
  }
  return rows;
}

describe("brush stroke Shift axis lock", () => {
  it("without Shift, a diagonal drag paints across more than one row", () => {
    const result = driveBrush([{ x: 10, y: 10 }, { x: 40, y: 40 }]);
    expect(paintedRows(result.working).length).toBeGreaterThan(1);
  });

  it("holding Shift partway through a mostly-horizontal drag locks the rest of it to one row", () => {
    // Starts drifting diagonally, then Shift engages — the stroke so far already leans
    // horizontal (dx > dy), so it should lock to horizontal from here on.
    const result = driveBrush([
      { x: 10, y: 20 }, { x: 20, y: 22, shiftKey: false },
      { x: 30, y: 30, shiftKey: true }, { x: 50, y: 45, shiftKey: true },
    ]);
    const rows = paintedRows(result.working);
    // Everything after the lock engaged stays on the row it locked to — not a single row for
    // the *whole* stroke (the un-locked lead-in already moved vertically), but a tight, bounded
    // band rather than the full diagonal sweep an unlocked stroke would leave.
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(15);
  });

  it("holding Shift throughout a horizontal drag paints a single straight row", () => {
    const result = driveBrush([
      { x: 10, y: 20, shiftKey: true }, { x: 20, y: 26, shiftKey: true }, { x: 50, y: 15, shiftKey: true },
    ]);
    // The lock engages on the very first move sample (dx already exceeds dy by then), so the
    // whole stroke after that stays within one brush-width's worth of rows around the anchor —
    // not zero spread (a 10px-wide soft brush covers more than one row even standing still),
    // but nowhere near the diagonal sweep an unlocked drag from y=20 to y=15 would leave either.
    const rows = paintedRows(result.working);
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(12);
  });

  it("holding Shift throughout a vertical drag paints a single straight column, not a diagonal", () => {
    const result = driveBrush([
      { x: 20, y: 10, shiftKey: true }, { x: 26, y: 20, shiftKey: true }, { x: 15, y: 50, shiftKey: true },
    ]);
    const spread = paintedRowSpread(result.working, 30);
    // A vertical lock keeps every row's own painted x roughly where the anchor column is,
    // not sweeping left/right the way the raw (unlocked) input would have.
    expect(spread.maxX - spread.minX).toBeLessThan(15);
  });

  it("releasing Shift mid-drag unlocks — the stroke resumes following the raw pointer", () => {
    const locked = driveBrush([{ x: 10, y: 20, shiftKey: true }, { x: 50, y: 20, shiftKey: true }]);
    const unlocked = driveBrush([
      { x: 10, y: 20, shiftKey: true }, { x: 30, y: 20, shiftKey: true },
      { x: 40, y: 40, shiftKey: false },
    ]);
    // Releasing Shift and moving further should reach further down than the fully-locked
    // (horizontal-only) stroke ever does.
    expect(Math.max(...paintedRows(unlocked.working))).toBeGreaterThan(Math.max(...paintedRows(locked.working)));
  });
});
