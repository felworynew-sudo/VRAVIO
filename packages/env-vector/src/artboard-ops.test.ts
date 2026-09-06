import { describe, expect, it } from "vitest";
import { computeCanvasBounds, createArtboardAt, deleteArtboard, duplicateArtboard, moveArtboard, rearrangeArtboardsGrid, renameArtboard, reorderArtboard, shapesIntersectingRect } from "./artboard-ops";
import { createShape, createVectorDocument } from "./document";
import { addShape, shapeWorldBounds } from "./shape-ops";

describe("artboard-ops (stage 15 of docs/vector-plan.md)", () => {
  it("computeCanvasBounds covers the document's own default area even with no artboards or shapes", () => {
    const state = createVectorDocument(200, 150);
    const bounds = computeCanvasBounds(state);
    expect(bounds.x).toBeLessThanOrEqual(0);
    expect(bounds.y).toBeLessThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(200);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(150);
  });

  it("a second artboard far from the origin is actually reachable — the whole point of this stage", () => {
    const state = createVectorDocument(200, 150);
    createArtboardAt(state, 5000, 5000, 300, 300);
    const bounds = computeCanvasBounds(state);
    // Before this stage, anything past (width, height) fell outside the
    // <svg viewBox="0 0 width height">'s own clip — this asserts the
    // computed canvas genuinely extends out to cover it, not just that an
    // Artboard object was appended to a list nothing reads.
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(5300);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(5300);
  });

  it("a shape sitting outside every artboard still expands the canvas — an artboard is metadata, not a container", () => {
    const state = createVectorDocument(200, 150);
    const shape = createShape("rectangle", 9000, 9000);
    addShape(state, shape);
    const bounds = computeCanvasBounds(state);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(9000 + 160);
  });

  it("createArtboardAt makes the new artboard active", () => {
    const state = createVectorDocument();
    const artboard = createArtboardAt(state, 0, 0, 400, 300, "Cover");
    expect(state.artboards).toContainEqual(artboard);
    expect(state.activeArtboardId).toBe(artboard.id);
  });

  it("duplicateArtboard offsets the copy so it isn't hidden exactly under the original", () => {
    const state = createVectorDocument();
    const original = createArtboardAt(state, 100, 100, 400, 300, "Page 1");
    const copy = duplicateArtboard(state, original.id)!;
    expect(copy).not.toBeNull();
    expect(copy.id).not.toBe(original.id);
    expect(copy.width).toBe(original.width);
    expect(copy.x === original.x && copy.y === original.y).toBe(false);
    expect(state.artboards).toHaveLength(2);
  });

  it("deleteArtboard removes only the rectangle, never the artwork under it", () => {
    const state = createVectorDocument();
    const artboard = createArtboardAt(state, 0, 0, 200, 200);
    const shape = createShape("rectangle", 10, 10);
    addShape(state, shape);

    deleteArtboard(state, artboard.id);

    expect(state.artboards).toHaveLength(0);
    expect(state.activeArtboardId).toBeNull();
    expect(state.shapes.some((item) => item.id === shape.id)).toBe(true);
  });

  it("deleting a non-active artboard leaves activeArtboardId alone", () => {
    const state = createVectorDocument();
    const first = createArtboardAt(state, 0, 0, 100, 100);
    const second = createArtboardAt(state, 200, 0, 100, 100);
    state.activeArtboardId = second.id;

    deleteArtboard(state, first.id);

    expect(state.activeArtboardId).toBe(second.id);
  });

  it("renameArtboard changes only the named artboard", () => {
    const state = createVectorDocument();
    const a = createArtboardAt(state, 0, 0, 100, 100, "A");
    const b = createArtboardAt(state, 200, 0, 100, 100, "B");
    renameArtboard(state, a.id, "Cover");
    expect(state.artboards.find((item) => item.id === a.id)?.name).toBe("Cover");
    expect(state.artboards.find((item) => item.id === b.id)?.name).toBe("B");
  });

  it("shapesIntersectingRect finds shapes overlapping the rect and excludes ones fully outside it", () => {
    const state = createVectorDocument();
    const inside = createShape("rectangle", 10, 10); // 160x100, so spans (10,10)-(170,110)
    const outside = createShape("rectangle", 5000, 5000);
    addShape(state, inside);
    addShape(state, outside);

    const found = shapesIntersectingRect(state, { x: 0, y: 0, width: 200, height: 200 });

    expect(found.map((shape) => shape.id)).toContain(inside.id);
    expect(found.map((shape) => shape.id)).not.toContain(outside.id);
  });

  it("shapesIntersectingRect is non-vacuous: a rect that overlaps nothing finds nothing", () => {
    const state = createVectorDocument();
    addShape(state, createShape("rectangle", 10, 10));
    expect(shapesIntersectingRect(state, { x: 900, y: 900, width: 50, height: 50 })).toHaveLength(0);
  });

  it("moveArtboard without Move Artwork leaves every shape exactly where it was", () => {
    const state = createVectorDocument();
    const artboard = createArtboardAt(state, 0, 0, 200, 200);
    const shape = createShape("rectangle", 10, 10);
    addShape(state, shape);
    const before = shapeWorldBounds(shape, state.shapes);

    moveArtboard(state, artboard.id, 500, 500, false);

    expect(state.artboards[0]!.x).toBe(500);
    expect(state.artboards[0]!.y).toBe(500);
    expect(shapeWorldBounds(state.shapes.find((item) => item.id === shape.id)!, state.shapes)).toEqual(before);
  });

  it("moveArtboard with Move Artwork carries along shapes it overlapped, and leaves the rest", () => {
    const state = createVectorDocument();
    const artboard = createArtboardAt(state, 0, 0, 200, 200);
    const inside = createShape("rectangle", 10, 10); // overlaps the artboard
    const outside = createShape("rectangle", 5000, 5000); // does not
    addShape(state, inside);
    addShape(state, outside);
    const outsideBefore = shapeWorldBounds(outside, state.shapes);

    moveArtboard(state, artboard.id, 300, 300, true);

    const insideAfter = shapeWorldBounds(state.shapes.find((item) => item.id === inside.id)!, state.shapes);
    expect(insideAfter).toEqual({ x: 310, y: 310, width: 160, height: 100 });
    const outsideAfter = shapeWorldBounds(state.shapes.find((item) => item.id === outside.id)!, state.shapes);
    expect(outsideAfter).toEqual(outsideBefore);
  });

  it("moveArtboard's `before` list is used as-is, not recomputed against the artboard's post-move position", () => {
    const state = createVectorDocument();
    const artboard = createArtboardAt(state, 0, 0, 200, 200);
    // Never actually overlapped the artboard — passed explicitly anyway,
    // simulating a tool that captured this list once at gesture start.
    const farAway = createShape("rectangle", 900, 900);
    addShape(state, farAway);

    moveArtboard(state, artboard.id, 50, 50, true, [farAway]);

    const after = shapeWorldBounds(state.shapes.find((item) => item.id === farAway.id)!, state.shapes);
    expect(after).toEqual({ x: 950, y: 950, width: 160, height: 100 });
  });

  it("reorderArtboard swaps list order without moving either rectangle", () => {
    const state = createVectorDocument();
    const a = createArtboardAt(state, 0, 0, 100, 100, "A");
    const b = createArtboardAt(state, 200, 0, 100, 100, "B");

    reorderArtboard(state, b.id, -1);

    expect(state.artboards.map((artboard) => artboard.id)).toEqual([b.id, a.id]);
    expect(state.artboards.find((artboard) => artboard.id === a.id)).toMatchObject({ x: 0, y: 0 });
    expect(state.artboards.find((artboard) => artboard.id === b.id)).toMatchObject({ x: 200, y: 0 });
  });

  it("reorderArtboard past either end is a no-op, not an error", () => {
    const state = createVectorDocument();
    const only = createArtboardAt(state, 0, 0, 100, 100);
    reorderArtboard(state, only.id, -1);
    reorderArtboard(state, only.id, 1);
    expect(state.artboards).toEqual([only]);
  });

  it("rearrangeArtboardsGrid (row layout) lays artboards out left-to-right, wrapping after `count` per row", () => {
    const state = createVectorDocument();
    // Scattered originally — the point of this command is to put them back
    // into a predictable grid regardless of where they'd drifted to.
    createArtboardAt(state, 900, 900, 100, 50, "0");
    createArtboardAt(state, -300, 400, 200, 100, "1"); // the largest — sets the uniform cell size
    createArtboardAt(state, 50, -50, 100, 50, "2");

    rearrangeArtboardsGrid(state, 2, 20, "row", false);

    const [a, b, c] = state.artboards;
    const originX = -300, originY = -50; // the minimum x/y across the original scattered positions
    const cellWidth = 200 + 20, cellHeight = 100 + 20; // the largest artboard's own size plus spacing
    expect(a).toMatchObject({ x: originX, y: originY });
    expect(b).toMatchObject({ x: originX + cellWidth, y: originY });
    expect(c).toMatchObject({ x: originX, y: originY + cellHeight }); // wrapped to row 2 after 2 per row
  });

  it("rearrangeArtboardsGrid (column layout) fills top-to-bottom, wrapping after `count` per column", () => {
    const state = createVectorDocument();
    createArtboardAt(state, 0, 0, 100, 100, "0");
    createArtboardAt(state, 0, 0, 100, 100, "1");
    createArtboardAt(state, 0, 0, 100, 100, "2");

    rearrangeArtboardsGrid(state, 2, 10, "column", false);

    const [a, b, c] = state.artboards;
    const cell = 100 + 10;
    expect(a).toMatchObject({ x: 0, y: 0 });
    expect(b).toMatchObject({ x: 0, y: cell }); // second in the first column
    expect(c).toMatchObject({ x: cell, y: 0 }); // wrapped to the next column after 2 per column
  });

  it("rearrangeArtboardsGrid with Move Artwork carries overlapping shapes, without it leaves them exactly where they were", () => {
    const state = createVectorDocument();
    createArtboardAt(state, 0, 0, 100, 100, "first"); // stays put — the origin of the grid
    const second = createArtboardAt(state, 500, 0, 100, 100, "second"); // will be pulled into row 1, col 1
    const shape = createShape("rectangle", 510, 10); // overlaps only the second artboard
    addShape(state, shape);
    const before = shapeWorldBounds(shape, state.shapes);

    rearrangeArtboardsGrid(state, 2, 20, "row", false);
    expect(state.artboards.find((artboard) => artboard.id === second.id)).toMatchObject({ x: 120, y: 0 }); // pulled in from 500 to right next to the first cell
    expect(shapeWorldBounds(state.shapes.find((item) => item.id === shape.id)!, state.shapes)).toEqual(before); // artwork left behind without the flag

    // Put the artboard back out where it started, then repeat with the flag on.
    moveArtboard(state, second.id, 500 - 120, 0, false);
    rearrangeArtboardsGrid(state, 2, 20, "row", true);
    expect(shapeWorldBounds(state.shapes.find((item) => item.id === shape.id)!, state.shapes)).not.toEqual(before);
  });

  it("rearrangeArtboardsGrid does nothing on an empty document", () => {
    const state = createVectorDocument();
    expect(() => rearrangeArtboardsGrid(state, 2, 20, "row", false)).not.toThrow();
    expect(state.artboards).toHaveLength(0);
  });
});
