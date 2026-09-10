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
}

function driveBrush(document: RasterDocumentState, path: readonly { x: number; altKey?: boolean }[][]): Recorded {
  const recorded: Recorded = { state: selectionBrush.createState!() as SelectionBrushState, selection: document.selection, commits: [], clears: 0 };
  const context = {
    documentId: "test-document",
    document,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options: { size: 10, hardness: 100, roundness: 100, spacing: 12 },
    get selection() { return recorded.selection; },
    get state() { return recorded.state; },
    setState: (next: SelectionBrushState) => { recorded.state = next; },
    capturePointer: () => {},
    previewWithLayerHidden: () => { recorded.clears += 1; },
    previewSelectionBrushMask: () => {},
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

  it("clears the live magenta tint on gesture end, since a selection-only commit never bumps the pixel revision that would otherwise repaint over it", () => {
    const document = createRasterDocument(WIDTH, HEIGHT);
    const result = driveBrush(document, [[{ x: 10 }, { x: 20 }]]);
    expect(result.clears).toBeGreaterThan(0);
  });
});
