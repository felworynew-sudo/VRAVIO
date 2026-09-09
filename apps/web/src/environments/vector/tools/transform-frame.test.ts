import { describe, expect, it } from "vitest";
import { FRAME_HANDLES, anchorPoint, handleAtScreenPoint, handlePoint, resizeRectByHandle, scaleForHandleDrag, unionBounds } from "./transform-frame";

const box = { x: 100, y: 200, width: 200, height: 100 };

describe("the selection frame", () => {
  it("has the same eight handles raster's transform frame has", () => {
    expect(FRAME_HANDLES).toHaveLength(8);
    // (0, 0) is the middle of the box, which is a place to grab and move, not a
    // handle to resize by.
    expect(FRAME_HANDLES.some((handle) => handle.x === 0 && handle.y === 0)).toBe(false);
  });

  it("puts each handle on the box", () => {
    expect(handlePoint(box, { x: -1, y: -1 })).toEqual({ x: 100, y: 200 });
    expect(handlePoint(box, { x: 1, y: 1 })).toEqual({ x: 300, y: 300 });
    expect(handlePoint(box, { x: 0, y: -1 })).toEqual({ x: 200, y: 200 });
    expect(handlePoint(box, { x: 1, y: 0 })).toEqual({ x: 300, y: 250 });
  });

  it("anchors a drag on the opposite handle", () => {
    // Drag the bottom-right and the top-left stays put — the thing that makes a
    // resize feel like it is pinned rather than sliding.
    expect(anchorPoint(box, { x: 1, y: 1 })).toEqual({ x: 100, y: 200 });
    expect(anchorPoint(box, { x: -1, y: 0 })).toEqual({ x: 300, y: 250 });
  });

  it("finds the handle a press caught, in screen pixels", () => {
    const handles = [
      { handle: { x: -1, y: -1 } as const, point: { x: 50, y: 60 } },
      { handle: { x: 1, y: 1 } as const, point: { x: 250, y: 160 } },
    ];
    expect(handleAtScreenPoint(handles, 52, 62)).toEqual({ x: -1, y: -1 });
    // Outside the grab radius — the press belongs to whatever is underneath.
    expect(handleAtScreenPoint(handles, 120, 100)).toBeNull();
    // Between two, the nearer one wins rather than whichever was listed first.
    expect(handleAtScreenPoint([...handles].reverse(), 249, 159)).toEqual({ x: 1, y: 1 });
  });

  it("scales by how far the pointer is from the anchor", () => {
    // Bottom-right dragged to twice the distance from the top-left: 2x on both.
    expect(scaleForHandleDrag(box, { x: 1, y: 1 }, { x: 500, y: 400 }, false)).toEqual({ x: 2, y: 2 });
  });

  it("leaves the other axis alone for a side handle", () => {
    // The right-middle handle scales width only; the pointer wandering
    // vertically must not squash the box.
    expect(scaleForHandleDrag(box, { x: 1, y: 0 }, { x: 500, y: 999 }, false)).toEqual({ x: 2, y: 1 });
    expect(scaleForHandleDrag(box, { x: 0, y: -1 }, { x: -999, y: 100 }, false)).toEqual({ x: 1, y: 2 });
  });

  it("keeps the aspect under Shift, following the larger factor", () => {
    const scale = scaleForHandleDrag(box, { x: 1, y: 1 }, { x: 500, y: 320 }, true);
    expect(scale.x).toBe(scale.y);
    expect(scale.x).toBe(2);
  });

  it("does not let a box collapse to nothing", () => {
    // Dragged exactly onto its own anchor: a zero factor would flatten the
    // shapes to a line no further drag could ever bring back.
    const scale = scaleForHandleDrag(box, { x: 1, y: 1 }, { x: 100, y: 200 }, false);
    expect(Math.abs(scale.x)).toBeGreaterThan(0);
    expect(Math.abs(scale.y)).toBeGreaterThan(0);
  });

  it("puts several objects in one box", () => {
    // The owner's request: a multiple selection gets a single frame around all
    // of it, not one frame per object.
    expect(unionBounds([{ x: 0, y: 0, width: 10, height: 10 }, { x: 90, y: 40, width: 10, height: 10 }]))
      .toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(unionBounds([])).toBeNull();
  });
});

describe("resizing an artboard by a handle", () => {
  const rect = { x: 100, y: 200, width: 200, height: 100 };

  it("moves the dragged corner and leaves the opposite one where it was", () => {
    expect(resizeRectByHandle(rect, { x: 1, y: 1 }, { x: 400, y: 500 }))
      .toEqual({ x: 100, y: 200, width: 300, height: 300 });
    // Dragging the top-left instead: the bottom-right is what holds still.
    expect(resizeRectByHandle(rect, { x: -1, y: -1 }, { x: 50, y: 150 }))
      .toEqual({ x: 50, y: 150, width: 250, height: 150 });
  });

  it("moves one edge only for a side handle", () => {
    // The pointer wandering vertically must not change the height.
    expect(resizeRectByHandle(rect, { x: 1, y: 0 }, { x: 400, y: 999 }))
      .toEqual({ x: 100, y: 200, width: 300, height: 100 });
    expect(resizeRectByHandle(rect, { x: 0, y: -1 }, { x: -999, y: 150 }))
      .toEqual({ x: 100, y: 150, width: 200, height: 150 });
  });

  it("flips rather than inverting when dragged past the anchor", () => {
    // Past the opposite corner the rectangle carries on as a normal rectangle
    // on the other side, never with a negative width.
    const flipped = resizeRectByHandle(rect, { x: 1, y: 1 }, { x: 40, y: 120 });
    expect(flipped.width).toBeGreaterThan(0);
    expect(flipped.height).toBeGreaterThan(0);
    expect(flipped.x).toBe(40);
    expect(flipped.y).toBe(120);
  });

  it("never collapses to nothing", () => {
    // Dropped exactly on its own anchor: a zero-sized artboard cannot be
    // clicked, so it could never be given its size back.
    const collapsed = resizeRectByHandle(rect, { x: 1, y: 1 }, { x: 100, y: 200 });
    expect(collapsed.width).toBeGreaterThanOrEqual(1);
    expect(collapsed.height).toBeGreaterThanOrEqual(1);
  });
});
