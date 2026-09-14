import { createRasterDocument, createRasterLayer, RasterTileCache } from "@vravio/env-raster";
import { describe, expect, it } from "vitest";
import { borrowCoverage, canDirectRasterPreviewBlit, releaseCoverage, tilesForCanvasPresentation, type CoverageScratch } from "./raster-commit";

describe("canDirectRasterPreviewBlit", () => {
  it("accepts the one case whose raw pixels equal the compositor", () => {
    const state = createRasterDocument(2, 2);
    expect(canDirectRasterPreviewBlit(state, state.layers[0]!)).toBe(true);
  });

  it.each([
    "mask", "fill", "clipping", "effects", "opacity", "blend", "extra-layer",
  ])("routes %s through the compositor", (variant) => {
    const state = createRasterDocument(2, 2);
    const layer = state.layers[0]!;
    if (variant === "mask") layer.mask = { pixels: new Uint8ClampedArray([255, 255, 255, 255]), assetId: null, enabled: true, linked: true, density: 1, feather: 0 };
    if (variant === "fill") layer.fillOpacity = .5;
    if (variant === "clipping") layer.clipping = true;
    if (variant === "effects") layer.effects = { dropShadow: { enabled: true, color: "#000000", opacity: 1, offsetX: 1, offsetY: 1 } };
    if (variant === "opacity") layer.opacity = .5;
    if (variant === "blend") layer.blendMode = "multiply";
    if (variant === "extra-layer") state.layers.push(createRasterLayer(2, 2));
    expect(canDirectRasterPreviewBlit(state, layer)).toBe(false);
  });
});

describe("coverage scratch pooling (docs/master-plan.md §37.6)", () => {
  it("hands out a fresh, zeroed buffer the first time", () => {
    const scratch = borrowCoverage(null, 8, 6);
    expect(scratch.width).toBe(8);
    expect(scratch.height).toBe(6);
    expect(scratch.buffer.length).toBe(48);
    expect([...scratch.buffer].every((value) => value === 0)).toBe(true);
  });

  it("hands back the exact same buffer object on a matching borrow", () => {
    const first = borrowCoverage(null, 8, 6);
    const second = borrowCoverage(first, 8, 6);
    expect(second.buffer).toBe(first.buffer);
  });

  it("clears only the rectangle the previous stroke released — not the whole canvas", () => {
    let scratch: CoverageScratch = borrowCoverage(null, 10, 10);
    scratch.buffer.fill(200); // every pixel "painted" by a first, canvas-covering stroke
    releaseCoverage(scratch, { x: 2, y: 3, width: 4, height: 2 }); // but only this much of it actually mattered
    scratch = borrowCoverage(scratch, 10, 10);
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        const inside = x >= 2 && x < 6 && y >= 3 && y < 5;
        expect(scratch.buffer[y * 10 + x], `(${x},${y})`).toBe(inside ? 0 : 200);
      }
    }
  });

  it("clips the released rectangle to the buffer instead of writing out of bounds", () => {
    let scratch: CoverageScratch = borrowCoverage(null, 4, 4);
    scratch.buffer.fill(255);
    // A brush dab reaching past the canvas edge — x spans [-2, 2), which clips to the two
    // columns [0, 2) actually on the canvas; same for y.
    releaseCoverage(scratch, { x: -2, y: -2, width: 4, height: 4 });
    scratch = borrowCoverage(scratch, 4, 4);
    expect(scratch.buffer[0]).toBe(0); // (0,0): inside the clipped rectangle
    expect(scratch.buffer[1]).toBe(0); // (1,0): inside the clipped rectangle
    expect(scratch.buffer[2]).toBe(255); // (2,0): one column past it, untouched
    expect(scratch.buffer[4 + 2]).toBe(255); // (2,1): same, on the next row
  });

  it("unions two releases before the next borrow into one bounding rectangle to clear", () => {
    // Two releases before a borrow ever runs — a mid-drag tool switch releasing the tool's own
    // stroke right after the workspace already released an unrelated one, say. `unionRect`'s own
    // convention (the same one `stroke.dirty` uses throughout paint-stroke.ts) is the bounding
    // box of the two, not their exact footprints — clearing a little more than strictly
    // necessary, never less, which is the safe direction for a buffer other code is about to read.
    let scratch: CoverageScratch = borrowCoverage(null, 10, 10);
    scratch.buffer.fill(9);
    releaseCoverage(scratch, { x: 0, y: 0, width: 2, height: 2 });
    releaseCoverage(scratch, { x: 8, y: 8, width: 2, height: 2 });
    scratch = borrowCoverage(scratch, 10, 10);
    expect(scratch.buffer[0]).toBe(0); // inside the first released rect
    expect(scratch.buffer[9 * 10 + 9]).toBe(0); // inside the second
    expect(scratch.buffer[5 * 10 + 5]).toBe(0); // inside their bounding box, though neither rect covered it
  });

  it("discards the old buffer outright when the document's own size changed", () => {
    const first = borrowCoverage(null, 8, 6);
    first.buffer.fill(255);
    const second = borrowCoverage(first, 16, 12);
    expect(second.buffer).not.toBe(first.buffer);
    expect(second.buffer.length).toBe(192);
    expect([...second.buffer].every((value) => value === 0)).toBe(true);
  });

  it("releasing null (a stroke that touched nothing) leaves a later borrow's clearing untouched", () => {
    let scratch: CoverageScratch = borrowCoverage(null, 4, 4);
    scratch.buffer.fill(50);
    releaseCoverage(scratch, null);
    scratch = borrowCoverage(scratch, 4, 4);
    expect([...scratch.buffer].every((value) => value === 50)).toBe(true);
  });
});

describe("tile canvas presentation", () => {
  it("re-blits cached visible tiles when returning to an earlier mip", () => {
    const document = createRasterDocument(64, 64, { backgroundColor: "#3366ff" });
    const cache = new RasterTileCache({ tileSize: 32 });
    const viewport = { x: 0, y: 0, width: 64, height: 64 };

    cache.update(document, viewport, { mip: 0 });
    cache.update(document, viewport, { mip: 1 });
    const returnedToFullResolution = cache.update(document, viewport, { mip: 0 });

    // The cache did no new composite work, but its valid mip-0 pixels must
    // still replace the stretched mip-1 pixels already painted to canvas.
    expect(returnedToFullResolution.repainted).toHaveLength(0);
    expect(returnedToFullResolution.visible).toHaveLength(4);
    expect(tilesForCanvasPresentation(returnedToFullResolution, true)).toEqual(returnedToFullResolution.visible);
    expect(tilesForCanvasPresentation(returnedToFullResolution, false)).toEqual(returnedToFullResolution.repainted);
  });
});
