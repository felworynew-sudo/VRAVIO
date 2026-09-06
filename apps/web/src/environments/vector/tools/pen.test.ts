import { describe, expect, it } from "vitest";
import { buildShapeSpatialIndex, createVectorDocument, emptyVectorStyle, IDENTITY_MATRIX, type VectorDocumentState } from "@vravio/env-vector";
import pen, { closePath, finishPath, type PenState } from "./definitions/pen";
import type { ToolContext, ToolPointer } from "./types";

/**
 * The gestures added 6 September 2026 (`docs/vector-plan.md` section 9,
 * "Долг: инструмент «Перо»", first priority) — the ones a live click-
 * through in the browser can't reliably exercise: `Alt` needs to stay held
 * across every synthetic pointer-move the browser automation tool sends
 * during one `left_click_drag`, and this pass found (the hard way, matching
 * `CLAUDE.md`'s own repeated lesson that a synthetic-input test can be the
 * broken half, not the code) that it does not — a live drag with
 * `modifiers: "alt"` still landed on a mirrored handle. Headless is the
 * reliable way to prove `Alt`/`Shift` actually change the outcome, the same
 * reason `contract.test.ts` exists at all.
 *
 * Lives here, next to `contract.test.ts`, not inside `definitions/` — that
 * directory is `registry.ts`'s own `import.meta.glob("./definitions/*.{tsx,ts}")`
 * scope, which reads every matched module's `default` export as a tool. A
 * `.test.ts` file placed there has none, and `vectorToolById`'s own
 * `.map((tool) => [tool.id, tool])` crashes on the resulting `undefined` —
 * found the moment this file was first added there, by the full suite
 * failing everywhere, not by this file's own tests (which passed fine in
 * isolation, since nothing in isolation ever imports `registry.ts`).
 */

function pointerAt(x: number, y: number, extra: Partial<ToolPointer> = {}): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, detail: 1, ...extra };
}

function makeContext(document: VectorDocumentState): { context: ToolContext<PenState> } {
  let state: PenState = pen.createState();
  const context: ToolContext<PenState> = {
    documentId: "test-document",
    document,
    viewport: { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "actual" },
    options: { strokeWidth: 2 },
    get activeShape() { return document.shapes.find((shape) => shape.id === document.activeShapeId) ?? null; },
    get selection() { return document.selection; },
    foregroundColor: "#101317",
    get spatialIndex() { return buildShapeSpatialIndex(document.shapes); },
    snapping: { sources: [], gridSpacing: null, radius: 0 },
    get state() { return state; },
    setState: (next) => { state = next; },
    mutate: (fn) => fn(document),
    snapshot: () => ({ shapes: structuredClone(document.shapes), activeShapeId: document.activeShapeId, selection: document.selection, artboards: structuredClone(document.artboards), activeArtboardId: document.activeArtboardId }),
    commitDrag: () => {},
    // Applies the mutator synchronously (like the real implementation's
    // own before-any-`await` ordering — see `vector-commands.ts`'s
    // `changeDocument`) so a test calling this via `void context.changeDocument(...)`
    // without awaiting still sees the effect on its very next assertion.
    changeDocument: async (_label, mutateFn) => { mutateFn(document); },
  };
  return { context };
}

function firstPath(document: VectorDocumentState) {
  const shape = document.shapes.find((item) => item.kind === "path");
  if (shape?.kind !== "path") throw new Error("expected a path shape");
  return shape;
}

describe("vector.pen — gestures added for docs/vector-plan.md section 9", () => {
  it("Shift constrains a new segment to the nearest 45°-multiple angle from the last point", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    // (100,100) -> (250,120): angle ≈ atan2(20,150) ≈ 7.6°, nearest 45°
    // multiple is 0° — the placed point should land with the same y as the
    // last point, not at (250,120).
    pen.onPointerDown!(context, pointerAt(250, 120, { shiftKey: true }));
    const path = firstPath(document);
    expect(path.points).toHaveLength(2);
    expect(path.points[1]!.y).toBeCloseTo(path.points[0]!.y, 5);
  });

  it("Shift constrains a handle drag to the nearest 45°-multiple angle", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    // Drag the handle at (100,100) toward (110, 60): angle ≈ atan2(-40,10) ≈
    // -76°, nearest 45°-multiple is -90° (straight up) — handleOut.x should
    // land at 0, not 10.
    pen.onPointerMove!(context, pointerAt(110, 60, { shiftKey: true }));
    const path = firstPath(document);
    expect(path.points[0]!.handleOut!.x).toBeCloseTo(0, 5);
    expect(path.points[0]!.handleOut!.y).toBeLessThan(0);
  });

  it("Alt breaks the handle from its mirror — handleIn stays untouched instead of mirroring handleOut", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onPointerMove!(context, pointerAt(140, 100, { altKey: true }));
    const path = firstPath(document);
    expect(path.points[0]!.handleOut).toEqual({ x: 40, y: 0 });
    // No handleIn was ever set on this fresh point, and Alt must not invent
    // one by mirroring handleOut — this is the exact bug a live browser
    // click-drag test could not catch (see this file's own doc comment).
    expect(path.points[0]!.handleIn).toBeUndefined();
  });

  it("without Alt, dragging a handle mirrors it onto handleIn (the existing symmetric-handle behaviour, unchanged)", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onPointerMove!(context, pointerAt(140, 100));
    const path = firstPath(document);
    expect(path.points[0]!.handleOut).toEqual({ x: 40, y: 0 });
    // `-0`, not `0` — dy is exactly 0 here, and `-dy` on a plain `0` in
    // JavaScript produces `-0`; `toEqual` distinguishes the two, so this
    // compares magnitude rather than bit-for-bit sign, which is not what
    // the mirroring behaviour itself is being tested for.
    expect(path.points[0]!.handleIn!.x).toBe(-40);
    expect(path.points[0]!.handleIn!.y).toBeCloseTo(0, 10);
  });

  it("clicking back on the path's own first point closes it instead of adding a new point", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    pen.onPointerDown!(context, pointerAt(200, 100));
    pen.onGestureEnd!(context, pointerAt(200, 100));
    pen.onPointerDown!(context, pointerAt(150, 180));
    pen.onGestureEnd!(context, pointerAt(150, 180));
    // Click within tolerance of the first point (100,100), not exactly on it —
    // matching how a real cursor never lands on the exact original pixel.
    pen.onPointerDown!(context, pointerAt(102, 101));
    const path = firstPath(document);
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(3);
    expect(context.state.draft).toBeNull();
  });

  it("does not close on a first-point click when only one point exists (a single point can't be a closed path)", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    pen.onPointerDown!(context, pointerAt(101, 100));
    const path = firstPath(document);
    expect(path.closed).toBe(false);
    expect(path.points).toHaveLength(2);
  });

  it("tracks the live cursor position in state while a path is in progress, for the rubber-band overlay", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    // Placing the first point already sets cursor to that same point (the
    // handle-drag anchor doubles as the initial rubber-band origin) —
    // what this test actually checks is that a later, distinct move
    // updates it, not that it starts out unset.
    expect(context.state.cursor).toEqual({ x: 100, y: 100 });
    pen.onPointerMove!(context, pointerAt(180, 140));
    expect(context.state.cursor).toEqual({ x: 180, y: 140 });
  });

  it("clicking near the open end of an existing path continues it instead of starting a new one", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    pen.onPointerDown!(context, pointerAt(160, 100));
    pen.onGestureEnd!(context, pointerAt(160, 100));
    finishPath(context);
    expect(document.shapes).toHaveLength(1);

    // Fresh gesture, no draft — but the click lands within tolerance of the
    // finished path's own last point (160,100), not exactly on it.
    pen.onPointerDown!(context, pointerAt(162, 101));
    pen.onGestureEnd!(context, pointerAt(162, 101));
    pen.onPointerDown!(context, pointerAt(220, 140));
    finishPath(context);

    // Still one shape — the continuation appended to it, it did not create
    // a second, separate path.
    expect(document.shapes).toHaveLength(1);
    expect(firstPath(document).points).toHaveLength(3);
  });

  it("does not continue a closed path — clicking one of its points deletes that point instead (see the dedicated delete-node tests below)", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    pen.onPointerDown!(context, pointerAt(160, 100));
    pen.onGestureEnd!(context, pointerAt(160, 100));
    pen.onPointerDown!(context, pointerAt(130, 160));
    pen.onGestureEnd!(context, pointerAt(130, 160));
    closePath(context);
    expect(document.shapes).toHaveLength(1);

    // Click near the now-closed path's last point: not "continue" (closed
    // paths have no continuable endpoint) and not "start a brand new path"
    // either — a closed path's points are all eligible for the delete-node
    // gesture (see below), which takes priority here.
    pen.onPointerDown!(context, pointerAt(131, 161));
    expect(document.shapes).toHaveLength(1);
    expect(firstPath(document).points).toHaveLength(2);
  });

  it("does not continue a path with only one point (nothing meaningfully open to continue) — deletes the stray point instead, same as any other single click on an existing point", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    finishPath(context);
    expect(document.shapes).toHaveLength(1);

    // A lone, already-committed 1-point path is not a continuable open
    // path (nothing meaningful to extend), and the delete-node gesture
    // takes over — the only way Pen could otherwise ever clean up a stray
    // single point.
    pen.onPointerDown!(context, pointerAt(101, 100));
    expect(document.shapes).toHaveLength(0);
  });

  it("clicking an existing interior point of a committed path deletes it, without leaving the Pen tool", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    pen.onPointerDown!(context, pointerAt(160, 100));
    pen.onGestureEnd!(context, pointerAt(160, 100));
    pen.onPointerDown!(context, pointerAt(160, 200));
    pen.onGestureEnd!(context, pointerAt(160, 200));
    pen.onPointerDown!(context, pointerAt(220, 200));
    finishPath(context);
    expect(firstPath(document).points).toHaveLength(4);

    // (160,100) is an interior point — not the first, not the (now
    // finished) last point of an open path.
    pen.onPointerDown!(context, pointerAt(161, 101));
    expect(firstPath(document).points).toHaveLength(3);
    expect(firstPath(document).points.some((point) => Math.hypot(point.x - 160, point.y - 100) < 5)).toBe(false);
  });

  it("deleting a point down to 2 removes the whole path instead of leaving a degenerate 1-point shape", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    pen.onPointerDown!(context, pointerAt(160, 100));
    pen.onGestureEnd!(context, pointerAt(160, 100));
    finishPath(context);
    expect(document.shapes).toHaveLength(1);

    // Both points of a 2-point path are "interior" in the sense that
    // neither is a continuable-open-path endpoint once the path is
    // finished and a fresh gesture starts (finishPath cleared the draft).
    // Deleting either one leaves nothing meaningful — the whole shape
    // goes, not a 1-point remainder.
    pen.onPointerDown!(context, pointerAt(101, 101));
    expect(document.shapes).toHaveLength(0);
  });

  it("clicking on a segment (not an endpoint) inserts a real new anchor there via De Casteljau, keeping a curved segment's exact shape", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    pen.onPointerDown!(context, pointerAt(200, 100));
    finishPath(context);
    expect(firstPath(document).points).toHaveLength(2);

    // Click on the midpoint of the straight segment between them.
    pen.onPointerDown!(context, pointerAt(150, 100));
    const path = firstPath(document);
    expect(path.points).toHaveLength(3);
    expect(path.points[1]!.x).toBeCloseTo(150, 0);
    expect(path.points[1]!.y).toBeCloseTo(100, 0);
  });

  it("finishing the path clears cursor tracking along with the rest of the draft state", () => {
    const document = createVectorDocument(400, 300);
    const { context } = makeContext(document);
    pen.onPointerDown!(context, pointerAt(100, 100));
    pen.onGestureEnd!(context, pointerAt(100, 100));
    pen.onPointerMove!(context, pointerAt(180, 140));
    finishPath(context);
    expect(context.state).toEqual({ draft: null, handle: null, cursor: null, nodeEdit: null });
  });

  describe("Ctrl/Cmd — temporary Node Tool", () => {
    it("Ctrl-dragging an anchor of the active shape moves it, without adding a new point or starting a draft", () => {
      const document = createVectorDocument(400, 300);
      document.shapes = [{
        id: "path-1", kind: "path", visible: true, locked: false,
        style: emptyVectorStyle(), parentId: null, orderKey: "a0", transform: IDENTITY_MATRIX, geometry: [],
        points: [{ x: 100, y: 100 }, { x: 200, y: 100 }], closed: false, name: "Test Path",
      }];
      document.activeShapeId = "path-1";
      const { context } = makeContext(document);

      pen.onPointerDown!(context, pointerAt(100, 100, { ctrlKey: true }));
      pen.onPointerMove!(context, pointerAt(130, 160, { ctrlKey: true }));
      pen.onGestureEnd!(context, pointerAt(130, 160, { ctrlKey: true }));

      const path = firstPath(document);
      expect(path.points).toHaveLength(2); // no point added
      expect(path.points[0]).toEqual({ x: 130, y: 160 });
      expect(context.state.draft).toBeNull(); // no drawing gesture started
    });

    it("Ctrl-dragging a handle of the shape currently being drawn moves that handle, leaving the draft intact so drawing can resume", () => {
      const document = createVectorDocument(400, 300);
      const { context } = makeContext(document);
      pen.onPointerDown!(context, pointerAt(100, 100));
      pen.onPointerMove!(context, pointerAt(140, 100)); // pulls a handleOut on point 0
      pen.onGestureEnd!(context, pointerAt(140, 100));
      expect(firstPath(document).points[0]!.handleOut).toEqual({ x: 40, y: 0 });

      // Ctrl-drag that same handle to a new offset — a plain Node Tool move,
      // not a new pen point, and mirrored onto handleIn exactly like
      // vector.nodes would (Alt not held here).
      pen.onPointerDown!(context, pointerAt(140, 100, { ctrlKey: true }));
      pen.onPointerMove!(context, pointerAt(100, 60, { ctrlKey: true }));
      pen.onGestureEnd!(context, pointerAt(100, 60, { ctrlKey: true }));

      const path = firstPath(document);
      expect(path.points).toHaveLength(1); // still the single in-progress point
      expect(path.points[0]!.handleOut).toEqual({ x: 0, y: -40 });
      // `-0`, not `0` — see the earlier Alt-handle test's own comment on
      // why this is compared by magnitude rather than bit-for-bit sign.
      expect(path.points[0]!.handleIn!.x).toBeCloseTo(0, 10);
      expect(path.points[0]!.handleIn!.y).toBe(40);
      expect(context.state.draft).not.toBeNull(); // drawing gesture still in progress

      // Drawing resumes normally after the Ctrl-edit ends.
      pen.onPointerDown!(context, pointerAt(200, 100));
      finishPath(context);
      expect(firstPath(document).points).toHaveLength(2);
    });

    it("holding Ctrl over empty canvas falls through to Pen's normal click behaviour instead of silently doing nothing", () => {
      const document = createVectorDocument(400, 300);
      const { context } = makeContext(document);
      pen.onPointerDown!(context, pointerAt(100, 100, { ctrlKey: true }));
      pen.onGestureEnd!(context, pointerAt(100, 100, { ctrlKey: true }));
      finishPath(context);
      expect(document.shapes).toHaveLength(1);
      expect(firstPath(document).points).toEqual([{ x: 100, y: 100 }]);
    });

    it("Ctrl + double-click on an anchor toggles corner ↔ smooth instead of starting a drag", () => {
      const document = createVectorDocument(400, 300);
      document.shapes = [{
        id: "path-1", kind: "path", visible: true, locked: false,
        style: emptyVectorStyle(), parentId: null, orderKey: "a0", transform: IDENTITY_MATRIX, geometry: [],
        points: [{ x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }], closed: false, name: "Test Path",
      }];
      document.activeShapeId = "path-1";
      const { context } = makeContext(document);

      // The middle anchor starts a plain corner (no handles).
      pen.onPointerDown!(context, pointerAt(100, 100, { ctrlKey: true, detail: 2 }));
      expect(context.state.nodeEdit).toBeNull(); // toggled, not dragging
      let middle = firstPath(document).points[1]!;
      expect(middle.handleIn).toBeDefined();
      expect(middle.handleOut).toBeDefined();

      // Toggling again turns it back into a plain corner.
      pen.onPointerDown!(context, pointerAt(100, 100, { ctrlKey: true, detail: 2 }));
      middle = firstPath(document).points[1]!;
      expect(middle.handleIn).toBeUndefined();
      expect(middle.handleOut).toBeUndefined();
    });
  });

  describe("cursorFor — hover preview of which of the five outcomes a click will produce", () => {
    it("hints a plain new point (no override) over empty canvas with no draft", () => {
      const document = createVectorDocument(400, 300);
      const { context } = makeContext(document);
      expect(pen.cursorFor!(context, pointerAt(200, 200))).toBeUndefined();
    });

    it("hints closing over the draft's own first point", () => {
      const document = createVectorDocument(400, 300);
      const { context } = makeContext(document);
      pen.onPointerDown!(context, pointerAt(100, 100));
      pen.onGestureEnd!(context, pointerAt(100, 100));
      pen.onPointerDown!(context, pointerAt(160, 100));
      pen.onGestureEnd!(context, pointerAt(160, 100));
      expect(pen.cursorFor!(context, pointerAt(101, 101))).toBe("alias");
      // Away from the first point, mid-draft, is a plain next point.
      expect(pen.cursorFor!(context, pointerAt(300, 200))).toBeUndefined();
    });

    it("hints delete over an existing point, but not over an open path's continuable last point", () => {
      const document = createVectorDocument(400, 300);
      const { context } = makeContext(document);
      pen.onPointerDown!(context, pointerAt(100, 100));
      pen.onGestureEnd!(context, pointerAt(100, 100));
      pen.onPointerDown!(context, pointerAt(160, 100));
      finishPath(context);
      expect(pen.cursorFor!(context, pointerAt(101, 101))).toBe("not-allowed");
      expect(pen.cursorFor!(context, pointerAt(161, 101))).toBe("grab"); // the continuable end
    });

    it("hints add-node (copy) over a segment, once no more specific hit (delete/continue) applies", () => {
      const document = createVectorDocument(400, 300);
      const { context } = makeContext(document);
      pen.onPointerDown!(context, pointerAt(100, 100));
      pen.onGestureEnd!(context, pointerAt(100, 100));
      pen.onPointerDown!(context, pointerAt(100, 200));
      finishPath(context);
      expect(pen.cursorFor!(context, pointerAt(100, 150))).toBe("copy");
    });

    it("hints grab over a node when Ctrl is held", () => {
      const document = createVectorDocument(400, 300);
      const { context } = makeContext(document);
      pen.onPointerDown!(context, pointerAt(100, 100));
      pen.onGestureEnd!(context, pointerAt(100, 100));
      pen.onPointerDown!(context, pointerAt(200, 100));
      finishPath(context);
      document.activeShapeId = firstPath(document).id;
      expect(pen.cursorFor!(context, pointerAt(101, 101, { ctrlKey: true }))).toBe("grab");
      // Without Ctrl, the very same position hints delete instead.
      expect(pen.cursorFor!(context, pointerAt(101, 101))).toBe("not-allowed");
    });
  });
});
