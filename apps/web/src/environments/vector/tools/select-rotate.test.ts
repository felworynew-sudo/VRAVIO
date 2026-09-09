import { describe, expect, it, vi } from "vitest";
import { applyMatrix, buildShapeSpatialIndex, createShape, createVectorDocument, rotateShapes, shapeWorldBounds, type VectorDocumentState } from "@vravio/env-vector";
import select, { type SelectState } from "./definitions/select";
import type { ToolContext, ToolPointer } from "./types";

/**
 * The owner's ask: vector's selection frame should rotate, with the same drawn cursors raster's
 * Free Transform uses. Rotation is the half that did not exist at all — the frame offered eight
 * scale handles and nothing else, so a shape could only ever be turned by editing its matrix.
 *
 * The engine half (`rotateShapes`) and the gesture half (the ring just outside a corner) are both
 * checked here, because either one alone would look like it worked: a gesture that writes nothing
 * and an engine nothing calls are equally invisible.
 */

const WIDTH = 800, HEIGHT = 600;

function documentWithRect(): VectorDocumentState {
  const state = createVectorDocument(WIDTH, HEIGHT) as VectorDocumentState;
  const shape = createShape("rectangle", 100, 100);
  if (shape.kind === "rectangle") { shape.width = 200; shape.height = 100; }
  state.shapes.push(shape);
  state.selection = [shape.id];
  state.activeShapeId = shape.id;
  return state;
}

function harness(zoom = 1) {
  const document = documentWithRect();
  const box: { state: SelectState } = { state: select.createState!() as SelectState };
  const commitDrag = vi.fn();
  const context = {
    documentId: "doc", document,
    viewport: { mode: "custom", zoom, panX: 0, panY: 0, rotation: 0 },
    workspaceSize: { width: WIDTH, height: HEIGHT }, stageBounds: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    options: {}, activeShape: null, selection: document.selection, foregroundColor: "#000000",
    get spatialIndex() { return buildShapeSpatialIndex(document.shapes); },
    snapping: { smartGuides: false, snapToGrid: false },
    get state() { return box.state; },
    setState: (next: SelectState) => { box.state = next; },
    mutate: (fn: (state: VectorDocumentState) => void) => { fn(document); return 1; },
    snapshot: () => document,
    commitDrag,
    changeDocument: (_label: string, fn: (state: VectorDocumentState) => boolean) => { fn(document); return Promise.resolve(); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ToolContext<SelectState>;
  return { context, document, box, commitDrag };
}

const at = (x: number, y: number, keys: { shiftKey?: boolean } = {}): ToolPointer => ({
  point: { x, y }, screenX: x, screenY: y, pointerId: 1,
  shiftKey: keys.shiftKey ?? false, altKey: false, ctrlKey: false, metaKey: false, button: 0, detail: 1,
});

/** The raw SVG behind a `cursor(url(data:...))` value, so a test can say *which* glyph came back
 * instead of only that some cursor did. */
function decodeCursor(cursor: string): string {
  const match = cursor.match(/url\("([^"]+)"\)/);
  if (!match) return cursor;
  return decodeURIComponent(match[1]!.replace(/^data:image\/svg\+xml,/, ""));
}

/** The bar every one of the owner's scale arrows carries, whichever way it points — the family's
 * own signature. The vertical arrow's arrowhead coordinate identifies that one specifically, and
 * the elbow path identifies a rotate glyph. */
const SCALE_ART = "width='132.37' height='51.1'";
const SCALE_ART_VERTICAL = "342.25 128.76";
const ROTATE_ART = "M54.09,341.55";

describe("rotateShapes", () => {
  it("turns a shape about the pivot it is given", () => {
    const state = documentWithRect();
    const id = state.shapes[0]!.id;
    // A quarter turn about the origin sends (100, 0) to (0, 100).
    rotateShapes(state, [id], { x: 0, y: 0 }, 90);
    const moved = applyMatrix(state.shapes[0]!.transform, { x: 100, y: 0 });
    expect(moved.x).toBeCloseTo(0, 6);
    expect(moved.y).toBeCloseTo(100, 6);
  });

  it("leaves a shape where it was after a full turn", () => {
    // Four quarter turns compose back to the identity — the check that the matrix is composed
    // rather than overwritten, which a single rotation cannot tell apart.
    const state = documentWithRect();
    const id = state.shapes[0]!.id;
    const before = shapeWorldBounds(state.shapes[0]!, state.shapes);
    const pivot = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    for (let quarter = 0; quarter < 4; quarter += 1) rotateShapes(state, [id], pivot, 90);
    const after = shapeWorldBounds(state.shapes[0]!, state.shapes);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.width).toBeCloseTo(before.width, 6);
    expect(after.height).toBeCloseTo(before.height, 6);
  });

  it("keeps the pivot itself fixed", () => {
    const state = documentWithRect();
    const id = state.shapes[0]!.id;
    const pivot = { x: 200, y: 150 };
    rotateShapes(state, [id], pivot, 37);
    // The pivot is a world point, so a shape turned about it maps that point back onto itself.
    const mapped = applyMatrix(state.shapes[0]!.transform, pivot);
    expect(mapped.x).toBeCloseTo(pivot.x, 6);
    expect(mapped.y).toBeCloseTo(pivot.y, 6);
  });
});

describe("the vector selection frame's rotate gesture", () => {
  it("turns the selection when the drag starts in the ring outside a corner", () => {
    const { context, document, commitDrag } = harness();
    const bounds = shapeWorldBounds(document.shapes[0]!, document.shapes);
    select.onPointerDown!(context, at(bounds.x - 12, bounds.y - 12));
    select.onPointerMove!(context, at(bounds.x - 12, bounds.y + bounds.height + 12));
    select.onGestureEnd!(context, at(bounds.x - 12, bounds.y + bounds.height + 12));

    expect(commitDrag).toHaveBeenCalledTimes(1);
    expect(String(commitDrag.mock.calls[0]![1])).toContain("Rotate");
    // The rectangle is 200x100; turned by anything that is not a multiple of 180° its
    // axis-aligned world bounds cannot still be 200 wide.
    const after = shapeWorldBounds(document.shapes[0]!, document.shapes);
    expect(Math.abs(after.width - bounds.width)).toBeGreaterThan(1);
  });

  it("scales, not rotates, when the press lands on the handle itself", () => {
    // The ring surrounds the handle, so the handle has to win inside its own grab area or the
    // scale gesture becomes unreachable.
    const { context, document, commitDrag } = harness();
    const bounds = shapeWorldBounds(document.shapes[0]!, document.shapes);
    select.onPointerDown!(context, at(bounds.x, bounds.y));
    select.onPointerMove!(context, at(bounds.x - 50, bounds.y - 50));
    select.onGestureEnd!(context, at(bounds.x - 50, bounds.y - 50));
    expect(commitDrag).toHaveBeenCalledTimes(1);
    expect(String(commitDrag.mock.calls[0]![1])).toContain("Scale");
  });

  it("snaps to 15° steps with Shift held", () => {
    const { context, document } = harness();
    const bounds = shapeWorldBounds(document.shapes[0]!, document.shapes);
    const pivot = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const from = { x: bounds.x - 12, y: bounds.y - 12 };
    select.onPointerDown!(context, at(from.x, from.y));
    // A little past 30° round the pivot: with Shift it has to land exactly on 30.
    const startAngle = Math.atan2(from.y - pivot.y, from.x - pivot.x);
    const radius = Math.hypot(from.x - pivot.x, from.y - pivot.y);
    const target = startAngle + (32 * Math.PI) / 180;
    select.onPointerMove!(context, at(pivot.x + Math.cos(target) * radius, pivot.y + Math.sin(target) * radius, { shiftKey: true }));

    const corner = applyMatrix(document.shapes[0]!.transform, { x: bounds.x, y: bounds.y });
    const turned = Math.atan2(corner.y - pivot.y, corner.x - pivot.x) - Math.atan2(bounds.y - pivot.y, bounds.x - pivot.x);
    expect((turned * 180) / Math.PI).toBeCloseTo(30, 4);
  });
});

describe("the vector selection frame's cursors", () => {
  it("shows a scale arrow on a handle and a rotate glyph just outside it", () => {
    const { context, document } = harness();
    const bounds = shapeWorldBounds(document.shapes[0]!, document.shapes);
    // The owner's own art, not a native keyword: every scale arrow carries its bar, the rotate
    // glyph its elbow path.
    expect(decodeCursor(select.cursorFor!(context, at(bounds.x, bounds.y))!)).toContain(SCALE_ART);
    expect(decodeCursor(select.cursorFor!(context, at(bounds.x - 12, bounds.y - 12))!)).toContain(ROTATE_ART);
  });

  it("puts the diagonal arrow on a corner and the straight one on an edge", () => {
    // Which arrow goes where is read off the owner's reference sheet: corners get the diagonal
    // whose bar is turned 135° (top-left and bottom-right share it), edges get the plain one.
    const { context, document } = harness();
    const b = shapeWorldBounds(document.shapes[0]!, document.shapes);
    const corner = decodeCursor(select.cursorFor!(context, at(b.x, b.y))!);
    expect(corner).toContain("rotate(135)");
    expect(corner).not.toContain(SCALE_ART_VERTICAL);
    const edge = decodeCursor(select.cursorFor!(context, at(b.x + b.width / 2, b.y))!);
    expect(edge).toContain(SCALE_ART_VERTICAL);
  });

  it("gives opposite corners the same scale arrow and each corner its own rotate glyph", () => {
    const { context, document } = harness();
    const b = shapeWorldBounds(document.shapes[0]!, document.shapes);
    const cursorAt = (x: number, y: number) => select.cursorFor!(context, at(x, y));
    expect(cursorAt(b.x, b.y)).toBe(cursorAt(b.x + b.width, b.y + b.height));
    const rings = [
      cursorAt(b.x - 12, b.y - 12), cursorAt(b.x + b.width + 12, b.y - 12),
      cursorAt(b.x - 12, b.y + b.height + 12), cursorAt(b.x + b.width + 12, b.y + b.height + 12),
    ];
    expect(new Set(rings).size).toBe(4);
  });

  it("holds the rotate glyph for the whole drag, even across a scale handle", () => {
    const { context, document } = harness();
    const b = shapeWorldBounds(document.shapes[0]!, document.shapes);
    select.onPointerDown!(context, at(b.x - 12, b.y - 12));
    // Straight over the top-left handle mid-drag: still a rotation, so still the rotate glyph.
    expect(decodeCursor(select.cursorFor!(context, at(b.x, b.y))!)).toContain(ROTATE_ART);
  });

  it("offers rotation near a handle but not far out — a vector editor bounds this zone", () => {
    // Graphite's `check_rotate`: outside the bounds *and* within a ±20px square of one of the
    // eight handle positions. Illustrator reads the same way from the user's side. Raster keeps
    // Krita's unbounded rule instead, and the difference between the two is deliberate.
    const { context, document } = harness();
    const b = shapeWorldBounds(document.shapes[0]!, document.shapes);
    expect(select.cursorFor!(context, at(b.x + b.width / 2, b.y + b.height / 2))).toBe("move");

    // Just off a corner, and just off an edge midpoint: both rotate.
    expect(decodeCursor(select.cursorFor!(context, at(b.x - 12, b.y - 12))!)).toContain(ROTATE_ART);
    expect(decodeCursor(select.cursorFor!(context, at(b.x + b.width / 2, b.y - 12))!)).toContain(ROTATE_ART);

    // Well past the zone there is nothing — the canvas belongs to whatever is under it.
    for (const [dx, dy] of [[-300, -300], [b.width + 200, b.height + 200], [b.width / 2, -400]] as const) {
      expect(select.cursorFor!(context, at(b.x + dx, b.y + dy)), `at ${dx},${dy}`).toBeUndefined();
    }
  });

  it("does not start a rotation from far outside the frame either", () => {
    // The cursor and the gesture have to agree: if no rotate cursor is shown out there, a press
    // out there must not rotate.
    const { context, document, commitDrag } = harness();
    const b = shapeWorldBounds(document.shapes[0]!, document.shapes);
    select.onPointerDown!(context, at(b.x - 300, b.y - 300));
    select.onPointerMove!(context, at(b.x - 260, b.y - 200));
    select.onGestureEnd!(context, at(b.x - 260, b.y - 200));
    for (const call of commitDrag.mock.calls) expect(String(call[1])).not.toContain("Rotate");
  });
});
