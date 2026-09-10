import { describe, expect, it } from "vitest";
import { createRasterDocument, layerDocumentPixels, layerOpaqueBounds, setLayerPixels, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";
import move, { type MoveState } from "./definitions/move";
import type { ToolContext, ToolPointer } from "./types";

/**
 * The owner's screenshot-2 report: moving a layer leaves a faint outline of the
 * content behind at the old position ("небольшая обводка осталась на месте"),
 * and it happens with no selection at all, so it is not the selector dropping
 * partly-transparent pixels.
 *
 * That report has two possible causes with very different fixes — the moved
 * *document* keeps the old pixels (a data bug in the move itself), or the
 * document is clean and only the canvas was not repainted there (a dirty-region
 * bug in the preview path). This file settles which, against the real tool
 * rather than by eye: it drives a whole press-drag-release over a soft-edged
 * blob and reads the committed document back.
 */

const DOCUMENT_WIDTH = 64, DOCUMENT_HEIGHT = 48;

/** A soft-edged disc: a fully opaque core inside a ring of partial alpha, which
 * is what an anti-aliased brush stroke's edge actually looks like. A hard-edged
 * fixture cannot show an "only the faint edge stayed behind" bug at all. */
function softBlobDocument(): RasterDocumentState {
  const state = createRasterDocument(DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
  const pixels = new Uint8ClampedArray(DOCUMENT_WIDTH * DOCUMENT_HEIGHT * 4);
  const centreX = 16, centreY = 16, radius = 6;
  for (let y = 0; y < DOCUMENT_HEIGHT; y += 1) for (let x = 0; x < DOCUMENT_WIDTH; x += 1) {
    const distance = Math.hypot(x - centreX, y - centreY);
    if (distance > radius + 1) continue;
    const coverage = distance <= radius ? 1 : radius + 1 - distance;
    const index = (y * DOCUMENT_WIDTH + x) * 4;
    pixels[index] = 20; pixels[index + 1] = 30; pixels[index + 2] = 40;
    pixels[index + 3] = Math.round(255 * coverage);
  }
  setLayerPixels(state.layers[0]!, pixels, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
  return state;
}

/** A rectangular marquee with full coverage, comfortably around the blob — the
 * ordinary "select it and drag it" case, where every pixel of the content is
 * fully inside the selection and nothing should be left behind. */
function selectAround(state: RasterDocumentState, rect: RasterRect): RasterDocumentState {
  const mask = new Uint8ClampedArray(DOCUMENT_WIDTH * DOCUMENT_HEIGHT);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) for (let x = rect.x; x < rect.x + rect.width; x += 1) mask[y * DOCUMENT_WIDTH + x] = 255;
  state.selection = { mask, bounds: { ...rect } };
  return state;
}

function pointerAt(x: number, y: number): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 1 };
}

interface Recorded {
  state: MoveState;
  previews: { pixels: Uint8ClampedArray; dirty: RasterRect | null }[];
  documentCommits: { after: RasterDocumentState; bounds: RasterRect | null }[];
}

function driveMove(document: RasterDocumentState, path: readonly { x: number; y: number }[]): Recorded {
  const recorded: Recorded = { state: move.createState!() as MoveState, previews: [], documentCommits: [] };
  const layer = document.layers.find((item) => item.id === document.activeLayerId)!;
  const context = {
    documentId: "test-document",
    document,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options: { autoSelect: false },
    activeLayer: layer,
    selection: document.selection,
    selectedLayers: [layer.id],
    paintTarget: { kind: "pixels", layerId: layer.id },
    get state() { return recorded.state; },
    setState: (next: MoveState) => { recorded.state = next; },
    capturePointer: () => {},
    layerPixels: () => layerDocumentPixels(layer, document.width, document.height),
    targetPixels: () => layerDocumentPixels(layer, document.width, document.height),
    schedulePreview: (pixels: Uint8ClampedArray, _target: string, _layerId: string, dirty?: RasterRect | null) => { recorded.previews.push({ pixels, dirty: dirty ?? null }); },
    schedulePreviewLayers: () => {},
    previewWithLayerHidden: () => {},
    commit: async () => {},
    commitSelection: async () => {},
    commitDocument: async (_before: RasterDocumentState, after: RasterDocumentState, _label: string, bounds: RasterRect | null = null) => { recorded.documentCommits.push({ after, bounds }); },
    setActiveLayer: () => {},
    setSelectedLayers: () => {},
    setForegroundColor: () => {},
    setMaskForegroundWhite: () => {},
    resetViewportToFit: () => {},
    setLastStrokePoint: () => {},
    setCloneSource: () => {},
    setCloneOffset: () => {},
    previewSpotHealMask: () => {}, previewSelectionBrushMask: () => {},
    // Synchronous, like contract.test.ts's own harness: the tool's per-frame
    // work then runs inside the same call and its effects are observable here.
    scheduleWork: (fn: () => void) => fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<MoveState>;

  move.onPointerDown!(context, pointerAt(path[0]!.x, path[0]!.y));
  for (const step of path.slice(1)) move.onPointerMove!(context, pointerAt(step.x, step.y));
  const last = path[path.length - 1]!;
  move.onGestureEnd!(context, pointerAt(last.x, last.y));
  // A move leaves the transform pending, exactly as it does in the app; the
  // document only changes when that pending transform is committed (Enter, a
  // click outside, or the tool deactivating), which is what onDeactivate does.
  move.onDeactivate!(context);
  return recorded;
}

/** Every pixel with any alpha at all, as "x,y" keys — no threshold, because the
 * whole question is whether the *faintest* pixels moved with the rest. */
function opaquePoints(pixels: Uint8ClampedArray, width: number, height: number): Set<string> {
  const points = new Set<string>();
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (pixels[(y * width + x) * 4 + 3]! > 0) points.add(`${x},${y}`);
  }
  return points;
}

describe("move tool leaves nothing behind", () => {
  it("moves every pixel of a soft-edged blob, faint edge included, with no selection", () => {
    const document = softBlobDocument();
    const before = layerDocumentPixels(document.layers[0]!, DOCUMENT_WIDTH, DOCUMENT_HEIGHT).slice();
    const sourcePoints = opaquePoints(before, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
    expect(sourcePoints.size).toBeGreaterThan(0);

    const shiftX = 24, shiftY = 12;
    const recorded = driveMove(document, [{ x: 16, y: 16 }, { x: 16 + shiftX, y: 16 + shiftY }]);
    expect(recorded.documentCommits).toHaveLength(1);

    const after = recorded.documentCommits[0]!.after;
    const moved = layerDocumentPixels(after.layers[0]!, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);
    const movedPoints = opaquePoints(moved, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);

    // Everything that was there is now exactly `shift` away, and nothing at all
    // is left at a source position that the shifted content does not cover.
    const expected = new Set<string>();
    for (const key of sourcePoints) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      expected.add(`${x + shiftX},${y + shiftY}`);
    }
    expect([...movedPoints].sort()).toEqual([...expected].sort());
  });

  it("moves the whole soft edge when a selection covers it, leaving no ghost outline behind", () => {
    // The owner's actual case: select the content, drag it. Every pixel of the
    // blob is fully inside the marquee (coverage 255), so the entire blob —
    // anti-aliased rim included — belongs to the float and none of it may stay.
    const document = selectAround(softBlobDocument(), { x: 4, y: 4, width: 28, height: 28 });
    const before = layerDocumentPixels(document.layers[0]!, DOCUMENT_WIDTH, DOCUMENT_HEIGHT).slice();
    const sourcePoints = opaquePoints(before, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);

    const shiftX = 24, shiftY = 12;
    const recorded = driveMove(document, [{ x: 16, y: 16 }, { x: 16 + shiftX, y: 16 + shiftY }]);
    expect(recorded.documentCommits).toHaveLength(1);
    const moved = layerDocumentPixels(recorded.documentCommits[0]!.after.layers[0]!, DOCUMENT_WIDTH, DOCUMENT_HEIGHT);

    // Nothing at all may remain where the blob used to be, at any alpha: the
    // ghost outline the owner photographed is exactly a few faint pixels here.
    const leftBehind: string[] = [];
    for (const key of sourcePoints) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const alphaNow = moved[(y * DOCUMENT_WIDTH + x) * 4 + 3]!;
      // A source pixel the moved content now covers is legitimately non-zero.
      const covered = sourcePoints.has(`${x - shiftX},${y - shiftY}`);
      if (!covered && alphaNow > 0) leftBehind.push(`${x},${y}:${alphaNow}`);
    }
    expect(leftBehind).toEqual([]);

    // And the content that arrived must be exactly as opaque as it started —
    // the same double-counted alpha that leaves a ghost behind also thins the
    // copy that moves, so checking only the source would miss half the bug.
    for (const key of sourcePoints) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const wasAlpha = before[(y * DOCUMENT_WIDTH + x) * 4 + 3]!;
      const nowAlpha = moved[((y + shiftY) * DOCUMENT_WIDTH + (x + shiftX)) * 4 + 3]!;
      expect(nowAlpha).toBe(wasAlpha);
    }
  });

  it("each frame repaints where the previous frame drew, not just the original and current position", () => {
    // The owner's screenshot-1 report: dragging fast leaves fragments of the
    // content scattered where it used to be. `renderWorkingRegion` repaints
    // strictly the rectangle a tool hands over, so what a frame does not cover
    // keeps whatever the *previous* frame painted there. The rectangle
    // therefore has to be "previous frame ∪ this frame" — which is exactly what
    // Patchy computes (`moving_layers_dirty_region(old_delta, new_delta)`,
    // canvas_widget_move.cpp, and `update_transform_preview_region(previous)`
    // for its transform preview). Covering "original ∪ current" instead leaves
    // any position off the straight line between those two behind on screen.
    //
    // Through a selection, which is what makes the repainted rectangle bounded
    // at all: with no selection the float covers the whole canvas, every frame
    // repaints everything, and no gap can exist to find.
    const selectionRect = { x: 4, y: 4, width: 28, height: 28 };
    const document = selectAround(softBlobDocument(), selectionRect);
    // Far right, then back left and down: the position at the elbow is nowhere
    // near the box spanned by the start and the end, which is what a fast drag
    // that changes direction looks like once frames are coalesced.
    const path = [{ x: 16, y: 16 }, { x: 60, y: 16 }, { x: 18, y: 40 }];
    const recorded = driveMove(document, path);
    const dirtyRects = recorded.previews.map((entry) => entry.dirty);
    expect(dirtyRects.every(Boolean)).toBe(true);

    // Where each frame actually drew, read out of the frame's own working buffer
    // rather than recomputed from the path: the float is the content's opaque
    // extent, not the marquee's, and re-deriving that here would only be a second
    // guess at what the tool did.
    const drawnAt = recorded.previews.map((entry) => layerOpaqueBounds(entry.pixels, DOCUMENT_WIDTH, DOCUMENT_HEIGHT));
    const contains = (outer: RasterRect, inner: RasterRect) => inner.x >= outer.x && inner.y >= outer.y
      && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

    const uncovered: string[] = [];
    for (let index = 1; index < recorded.previews.length; index += 1) {
      const previous = drawnAt[index - 1], dirty = dirtyRects[index]!;
      if (previous && !contains(dirty, previous)) uncovered.push(`frame ${index} repaints ${JSON.stringify(dirty)}, missing where frame ${index - 1} drew: ${JSON.stringify(previous)}`);
    }
    expect(uncovered).toEqual([]);
  });
});
