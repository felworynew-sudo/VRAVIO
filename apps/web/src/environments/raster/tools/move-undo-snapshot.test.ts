import { describe, expect, it } from "vitest";
import { cloneRasterState, createRasterDocument, layerDocumentPixels, setLayerPixels, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";
import move, { type MoveState } from "./definitions/move";
import type { ToolContext, ToolPointer } from "./types";

/**
 * `DocumentStore.update(id, mutator)` (packages/kernel/src/document-store.ts) hands the mutator
 * the document's own live `state` object and lets it mutate that object's fields in place — it
 * never swaps in a fresh object. `commitDocumentState`'s `assign` (raster-commit.ts) leans on
 * that: `Object.assign(current, cloneRasterState(snapshot))` writes `snapshot`'s fields directly
 * onto whatever live object `current` happens to be.
 *
 * A "before" snapshot captured as a bare reference to that same live object is therefore not a
 * snapshot at all — the very `redo()` that applies "after" mutates "before" into "after" too,
 * since they were never two objects. Every commit through `commitPending`/`startPendingTransform`
 * used to do exactly this (`const current = context.document`), so Undo after any Move/Scale/
 * Rotate/Quad/Warp silently reapplied a no-op. Fixed by cloning before capturing "before" — this
 * file proves the fix the way `DocumentStore.update` would actually exercise it: mutate the same
 * object `context.document` pointed at, the moment after the commit, and check "before" didn't
 * move with it.
 */

const WIDTH = 48, HEIGHT = 48;

function paintedDocument(): RasterDocumentState {
  const state = createRasterDocument(WIDTH, HEIGHT);
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 10; y < 20; y += 1) for (let x = 8; x < 20; x += 1) {
    const index = (y * WIDTH + x) * 4;
    pixels[index] = 200; pixels[index + 1] = 40; pixels[index + 2] = 40; pixels[index + 3] = 255;
  }
  setLayerPixels(state.layers[0]!, pixels, WIDTH, HEIGHT);
  return state;
}

function pointerAt(x: number, y: number): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 1 };
}

interface CommitCall { before: RasterDocumentState; after: RasterDocumentState; bounds: RasterRect | null }

function driveMoveAndCapture(document: RasterDocumentState, path: readonly { x: number; y: number }[]): CommitCall[] {
  const calls: CommitCall[] = [];
  const box: { state: MoveState } = { state: move.createState!() as MoveState };
  const layer = document.layers.find((item) => item.id === document.activeLayerId)!;
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
    commit: async () => {}, commitSelection: async () => {},
    commitDocument: async (before: RasterDocumentState, after: RasterDocumentState, _label: string, bounds: RasterRect | null = null) => {
      calls.push({ before, after, bounds });
    },
    setActiveLayer: () => {}, setSelectedLayers: () => {}, setForegroundColor: () => {},
    setMaskForegroundWhite: () => {}, resetViewportToFit: () => {}, setLastStrokePoint: () => {},
    setCloneSource: () => {}, setCloneOffset: () => {}, previewSpotHealMask: () => {}, previewSelectionBrushMask: () => {},
    scheduleWork: (fn: () => void) => fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<MoveState>;

  move.onPointerDown!(context, pointerAt(path[0]!.x, path[0]!.y));
  for (const step of path.slice(1)) move.onPointerMove!(context, pointerAt(step.x, step.y));
  move.onGestureEnd!(context, pointerAt(path[path.length - 1]!.x, path[path.length - 1]!.y));
  move.onDeactivate!(context);
  return calls;
}

describe("commitPending's undo snapshot survives the redo that follows it", () => {
  it("a fresh, unselected, non-text move (the live-eligible path) hands commitDocument a real clone", () => {
    const document = paintedDocument();
    const originalBounds = { ...document.layers[0]!.bounds };
    const calls = driveMoveAndCapture(document, [{ x: 14, y: 15 }, { x: 30, y: 32 }]);
    expect(calls).toHaveLength(1);
    const { before } = calls[0]!;

    // The bug's own mechanism, reproduced directly: DocumentStore.update's mutator writes the
    // "after" snapshot's fields onto whatever live object the caller is holding — simulate that
    // exact write against `document` (what `context.document` pointed at during the commit) and
    // check "before" didn't move with it.
    Object.assign(document, cloneRasterState(calls[0]!.after));

    expect(before.layers[0]!.bounds).toEqual(originalBounds);
    expect(before).not.toBe(document);
  });

  it("commitPending is never handed context.document's own live reference as \"before\"", () => {
    const document = paintedDocument();
    const calls = driveMoveAndCapture(document, [{ x: 14, y: 15 }, { x: 30, y: 32 }]);
    expect(calls[0]!.before).not.toBe(document);
  });
});
