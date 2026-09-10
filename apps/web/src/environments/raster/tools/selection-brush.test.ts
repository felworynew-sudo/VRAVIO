import { describe, expect, it } from "vitest";
import { createRasterDocument, type PixelSelection, type RasterDocumentState } from "@vravio/env-raster";
import selectionBrush, { type SelectionBrushState } from "./definitions/selection-brush";
import type { ToolContext, ToolPointer } from "./types";

/**
 * The owner asked for Photoshop's Selection Brush (L): paint adds to the
 * selection, Alt-paint subtracts — live, in the same stroke. The one part of
 * that contract a live browser drive could not confirm this session: this
 * codebase's Browser-pane automation does not carry a held Alt through a
 * synthetic drag (`modifiers: "alt"` produced `altKey: false` on every
 * resulting pointer event, checked directly by listening on
 * `.raster-pointer-field`) — a tooling gap, not a claim about the tool's own
 * code, which reads `pointer.altKey` off the real `PointerEvent` the same way
 * every other modifier-aware raster tool in this file does. Driving the tool
 * function directly, the way `move-residue.test.ts` already does for its own
 * tool, tests the actual code path without depending on that harness.
 */

const WIDTH = 40, HEIGHT = 40;

function pointerAt(x: number, y: number, altKey = false): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey, ctrlKey: false, metaKey: false, button: 0, pressure: 1 };
}

interface Recorded {
  state: SelectionBrushState;
  selection: PixelSelection | null;
  commits: { before: PixelSelection | null; after: PixelSelection | null }[];
  clears: number;
  paints: { mask: Uint8ClampedArray; originX: number; originY: number; width: number; height: number }[];
}

function driveBrush(document: RasterDocumentState, path: readonly { x: number; altKey?: boolean }[][], options: Record<string, string | number | boolean> = { size: 10, hardness: 100, roundness: 100, spacing: 12 }): Recorded {
  const recorded: Recorded = { state: selectionBrush.createState!() as SelectionBrushState, selection: document.selection, commits: [], clears: 0, paints: [] };
  const context = {
    documentId: "test-document",
    document,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options,
    get selection() { return recorded.selection; },
    get state() { return recorded.state; },
    setState: (next: SelectionBrushState) => { recorded.state = next; },
    capturePointer: () => {},
    previewWithLayerHidden: () => { recorded.clears += 1; },
    previewSelectionBrushMask: (mask: Uint8ClampedArray, originX: number, originY: number, width: number, height: number) => { recorded.paints.push({ mask, originX, originY, width, height }); },
    // Synchronous, like contract.test.ts's own harness: coalesced per-frame
    // work then runs inside the same call and its effects are observable here.
    scheduleWork: (fn: () => void) => fn(),
    commitSelection: async (before: PixelSelection | null, after: PixelSelection | null) => {
      recorded.commits.push({ before, after });
      recorded.selection = after;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<SelectionBrushState>;

  for (const stroke of path) {
    selectionBrush.onPointerDown!(context, pointerAt(stroke[0]!.x, 20, stroke[0]!.altKey));
    for (const step of stroke.slice(1)) selectionBrush.onPointerMove!(context, pointerAt(step.x, 20, step.altKey));
    selectionBrush.onGestureEnd!(context, pointerAt(stroke[stroke.length - 1]!.x, 20, stroke[stroke.length - 1]!.altKey));
  }
  return recorded;
}

function maskSum(selection: PixelSelection | null): number {
  if (!selection) return 0;
  let sum = 0;
  for (const value of selection.mask) sum += value;
  return sum;
}

describe("selection brush tool", () => {
  it("painting adds to the selection", () => {
    const document = createRasterDocument(WIDTH, HEIGHT);
    const result = driveBrush(document, [[{ x: 10 }, { x: 15 }, { x: 20 }]]);
    expect(result.selection).not.toBeNull();
    expect(maskSum(result.selection)).toBeGreaterThan(0);
    expect(result.commits).toHaveLength(1);
  });

  it("holding Alt subtracts from what was just painted, in the same session", () => {
    const document = createRasterDocument(WIDTH, HEIGHT);
    const added = driveBrush(document, [[{ x: 10 }, { x: 15 }, { x: 20 }]]);
    const addedSum = maskSum(added.selection);
    expect(addedSum).toBeGreaterThan(0);

    document.selection = added.selection;
    const subtracted = driveBrush(document, [[{ x: 10, altKey: true }, { x: 15, altKey: true }, { x: 20, altKey: true }]]);
    expect(maskSum(subtracted.selection)).toBeLessThan(addedSum);
    // Painted and then erased along the identical path with the same round,
    // full-hardness tip — nothing should be left standing.
    expect(subtracted.selection).toBeNull();
  });

  it("switches mode mid-stroke: the Alt half of a single drag erases only where Alt was actually held", () => {
    const document = createRasterDocument(WIDTH, HEIGHT);
    // One continuous stroke: add from x=5 to x=25, then Alt-subtract back from x=25 to x=15.
    const result = driveBrush(document, [[{ x: 5 }, { x: 25 }, { x: 15, altKey: true }]]);
    const selection = result.selection;
    expect(selection).not.toBeNull();
    // The untouched-by-Alt head of the stroke (around x=5-10) should still be selected...
    let headSelected = false;
    for (let x = 4; x <= 9; x += 1) if (selection!.mask[20 * WIDTH + x]! > 0) headSelected = true;
    expect(headSelected).toBe(true);
    // ...while the region the Alt pass swept back over (around x=16-24) should not be.
    let sweptSelected = false;
    for (let x = 16; x <= 24; x += 1) if (selection!.mask[20 * WIDTH + x]! > 0) sweptSelected = true;
    expect(sweptSelected).toBe(false);
  });

  it("does not clear the canvas on gesture end — the live tint already shows the exact final mask, and clearing it here would only flash before the async commit re-derives the same picture", () => {
    const document = createRasterDocument(WIDTH, HEIGHT);
    const result = driveBrush(document, [[{ x: 10 }, { x: 20 }]]);
    expect(result.clears).toBe(0);
  });

  it("opacity dims the live tint's own painted values without changing what gets selected", () => {
    const full = driveBrush(createRasterDocument(WIDTH, HEIGHT), [[{ x: 10 }, { x: 20 }]], { size: 10, hardness: 100, roundness: 100, spacing: 12, opacity: 100 });
    const dim = driveBrush(createRasterDocument(WIDTH, HEIGHT), [[{ x: 10 }, { x: 20 }]], { size: 10, hardness: 100, roundness: 100, spacing: 12, opacity: 25 });
    expect(full.paints.length).toBeGreaterThan(0);
    const fullPeak = Math.max(...full.paints.flatMap((paint) => [...paint.mask]));
    const dimPeak = Math.max(...dim.paints.flatMap((paint) => [...paint.mask]));
    expect(fullPeak).toBe(255);
    // 25% of 255, rounded — the same scaling `paintTint` applies.
    expect(dimPeak).toBe(Math.round(255 * 0.25));
    // The committed selection itself is identical either way: opacity never
    // touches what ends up selected, only how the wash is drawn.
    expect(maskSum(full.selection)).toBe(maskSum(dim.selection));
  });

  it("closing a loop (release lands back near the start) fills its own enclosed interior, like Photoshop's lasso", () => {
    const size = 80, hardness = 100, roundness = 100, spacing = 12;
    const width = 300, height = 300;
    const document = createRasterDocument(width, height);
    const recorded: Recorded = { state: selectionBrush.createState!() as SelectionBrushState, selection: document.selection, commits: [], clears: 0, paints: [] };
    const context = {
      documentId: "test-document",
      document,
      viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
      options: { size, hardness, roundness, spacing },
      get selection() { return recorded.selection; },
      get state() { return recorded.state; },
      setState: (next: SelectionBrushState) => { recorded.state = next; },
      capturePointer: () => {},
      previewWithLayerHidden: () => { recorded.clears += 1; },
      previewSelectionBrushMask: () => {},
      scheduleWork: (fn: () => void) => fn(),
      commitSelection: async (before: PixelSelection | null, after: PixelSelection | null) => {
        recorded.commits.push({ before, after });
        recorded.selection = after;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as ToolContext<SelectionBrushState>;

    // A ring around the document's own centre — 8 points around a circle,
    // ending back on the first one. A radius comfortably larger than half
    // the brush's own size, so the ring has a real hole in the middle that
    // the brush itself never paints over directly.
    const centerX = width / 2, centerY = height / 2, radius = 100;
    const ring: { x: number; y: number }[] = [];
    for (let step = 0; step <= 16; step += 1) {
      const angle = (step / 16) * Math.PI * 2;
      ring.push({ x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius });
    }

    const point = (p: { x: number; y: number }, altKey = false): ToolPointer => ({ point: p, screenX: p.x, screenY: p.y, pointerId: 1, shiftKey: false, altKey, ctrlKey: false, metaKey: false, button: 0, pressure: 1 });
    selectionBrush.onPointerDown!(context, point(ring[0]!));
    for (const step of ring.slice(1)) selectionBrush.onPointerMove!(context, point(step));
    selectionBrush.onGestureEnd!(context, point(ring[ring.length - 1]!));

    const selection = recorded.selection!;
    expect(selection).not.toBeNull();
    // The centre — comfortably inside the ring, never itself under the brush tip.
    expect(selection.mask[Math.round(centerY) * width + Math.round(centerX)]).toBe(255);
    // Well outside the ring stays unselected.
    expect(selection.mask[10 * width + 10]).toBe(0);
  });

  it("does not fill anything when the loop stays open (release lands nowhere near the start)", () => {
    const document = createRasterDocument(200, 200);
    // A straight, wide-open stroke — release far from the start, no ring to speak of.
    const result = driveBrush(document, [[{ x: 20 }, { x: 100 }, { x: 180 }]], { size: 20, hardness: 100, roundness: 100, spacing: 12 });
    const selection = result.selection!;
    // Only the brush's own stroke area is selected — nowhere near the whole
    // 200×200 canvas, which is what an erroneous "fill anyway" would produce.
    expect(maskSum(selection)).toBeLessThan(255 * 200 * 40);
  });

  it("deactivating the tool clears the wash — it represents the tool being active, not the selection itself", () => {
    const document = createRasterDocument(WIDTH, HEIGHT);
    const state = selectionBrush.createState!() as SelectionBrushState;
    let clears = 0;
    const context = {
      documentId: "test-document",
      document,
      selection: null,
      state,
      setState: () => {},
      previewWithLayerHidden: () => { clears += 1; },
      scheduleWork: (fn: () => void) => fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as ToolContext<SelectionBrushState>;
    selectionBrush.onDeactivate!(context);
    expect(clears).toBe(1);
  });
});
