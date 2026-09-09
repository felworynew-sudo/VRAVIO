import { describe, expect, it } from "vitest";
import { createRasterDocument } from "@vravio/env-raster";
import move, { type MoveState, type PendingTransform } from "./definitions/move";
import type { ToolContext, ToolPointer } from "./types";

/**
 * `move.cursorFor` — the owner's own live complaint after the rotate-corner zone shipped: hovering
 * a scale handle mid-rotate-drag flipped the cursor away from the rotate glyph, even though the
 * drag itself kept rotating correctly. That is a "drag in progress" bug a live hover test cannot
 * pin down reliably (the Browser pane's synthetic input does not let a drag be held open while a
 * second position is sampled mid-gesture — see docs/master-plan.md section 29's own note on
 * `dispatchEvent` being unreliable here), so it is pinned here instead, against the pure function.
 */

const document = createRasterDocument(200, 150);

function fakePointer(x: number, y: number): ToolPointer {
  return { point: { x, y }, screenX: x, screenY: y, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 1 };
}

function fakeContext(state: MoveState): ToolContext<MoveState> {
  return {
    documentId: "doc-1", document, viewport: { zoom: 1, panX: 0, panY: 0, rotation: 0 },
    options: {}, activeLayer: null, selection: null, selectedLayers: [], paintTarget: { kind: "pixels", layerId: "" },
    state, setState: () => {}, capturePointer: () => {}, scheduleWork: () => {}, schedulePreview: () => {}, schedulePreviewLayers: () => {},
    previewWithLayerHidden: () => {}, commitDocument: async () => {}, commit: () => {}, setActiveLayer: () => {}, setSelectedLayers: () => {},
    setForeground: () => {}, setMaskForegroundWhite: () => {}, resetViewport: () => {}, setLastStrokePoint: () => {}, setCloneSource: () => {},
    setCloneOffset: () => {}, setSpotHealPreview: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const bounds = { x: 10, y: 10, width: 100, height: 80 };
const pending: PendingTransform = {
  before: document, layerId: "layer-1", dx: 0, dy: 0, pixels: new Uint8ClampedArray(document.width * document.height * 4),
  selection: { mask: new Uint8ClampedArray(document.width * document.height).fill(255), bounds }, rotation: 0,
};

/** Decodes a `cursor(...)` data-URI string back to its raw SVG markup, so a test can pin down
 * *which* glyph came back instead of just checking a generic substring like "alias". */
function decodeCursorSvg(cursor: string): string {
  const match = cursor.match(/url\("([^"]+)"\)/);
  if (!match) return cursor;
  return decodeURIComponent(match[1]!.replace(/^data:image\/svg\+xml,/, ""));
}

/**
 * Which corner a rotate cursor is drawn for.
 *
 * The four are the owner's one supplied path (`Rotate-DL.svg`, the top-left elbow) plus a
 * reflection each, so the reflection *is* the identity of the glyph: no transform is top-left,
 * a horizontal flip is top-right, a vertical flip is bottom-left, both is bottom-right. Reading
 * it back out of the data URI is how a test tells all four apart — and unlike matching some
 * coordinate inside the artwork, it keeps meaning the same thing if the owner redraws the path.
 */
function rotateCorner(cursor: string): "TL" | "TR" | "BL" | "BR" | "not-a-rotate-cursor" {
  const svg = decodeCursorSvg(cursor);
  if (!svg.includes("M54.09,341.55")) return "not-a-rotate-cursor";
  const flipX = svg.includes("scale(-1 1)"), flipY = svg.includes("scale(1 -1)"), flipBoth = svg.includes("scale(-1 -1)");
  if (flipBoth) return "BR";
  if (flipX) return "TR";
  if (flipY) return "BL";
  return "TL";
}

describe("move tool's cursor hint", () => {
  it("gives no hint without a pending transform", () => {
    expect(move.cursorFor!(fakeContext({ pending: null, drag: null }), fakePointer(0, 0))).toBeUndefined();
  });

  it("gives a diagonal resize cursor on a corner handle", () => {
    const cursor = move.cursorFor!(fakeContext({ pending, drag: null }), fakePointer(bounds.x + bounds.width, bounds.y));
    expect(cursor).toContain("nesw-resize");
  });

  it("shares the exact same glyph between a diagonal's two opposite corners — a straight double-headed arrow reads the same rotated 180°, so TL/BR (and TR/BL) must be byte-identical, not four separate per-corner assets", () => {
    const topLeft = move.cursorFor!(fakeContext({ pending, drag: null }), fakePointer(bounds.x, bounds.y));
    const bottomRight = move.cursorFor!(fakeContext({ pending, drag: null }), fakePointer(bounds.x + bounds.width, bounds.y + bounds.height));
    expect(topLeft).toBe(bottomRight);
    const topRight = move.cursorFor!(fakeContext({ pending, drag: null }), fakePointer(bounds.x + bounds.width, bounds.y));
    const bottomLeft = move.cursorFor!(fakeContext({ pending, drag: null }), fakePointer(bounds.x, bounds.y + bounds.height));
    expect(topRight).toBe(bottomLeft);
    expect(topLeft).not.toBe(topRight);
  });

  it("gives each corner's rotate zone that corner's own glyph, the way the reference sheet places them", () => {
    // `пример.svg` draws every rotate glyph just outside the corner it belongs to, so the mapping
    // is direct. (It was mirrored before, but only because the old art was a scale bracket
    // pressed into rotate duty — this set is drawn for the job.)
    const at = (x: number, y: number) => move.cursorFor!(fakeContext({ pending, drag: null }), fakePointer(x, y));
    expect(rotateCorner(at(bounds.x - 15, bounds.y - 15)!)).toBe("TL");
    expect(rotateCorner(at(bounds.x + bounds.width + 15, bounds.y - 15)!)).toBe("TR");
    expect(rotateCorner(at(bounds.x - 15, bounds.y + bounds.height + 15)!)).toBe("BL");
    expect(rotateCorner(at(bounds.x + bounds.width + 15, bounds.y + bounds.height + 15)!)).toBe("BR");
  });

  it("gives all four corners a different rotate glyph — a bend is not 180°-symmetric the way the scale arrow is", () => {
    const at = (x: number, y: number) => move.cursorFor!(fakeContext({ pending, drag: null }), fakePointer(x, y));
    const corners = [
      at(bounds.x - 15, bounds.y - 15)!, at(bounds.x + bounds.width + 15, bounds.y - 15)!,
      at(bounds.x - 15, bounds.y + bounds.height + 15)!, at(bounds.x + bounds.width + 15, bounds.y + bounds.height + 15)!,
    ];
    expect(new Set(corners).size).toBe(4);
  });

  it("gives a move cursor inside the frame, away from any handle", () => {
    expect(move.cursorFor!(fakeContext({ pending, drag: null }), fakePointer(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))).toBe("move");
  });

  it("gives no hint outside the frame", () => {
    expect(move.cursorFor!(fakeContext({ pending, drag: null }), fakePointer(bounds.x - 50, bounds.y - 50))).toBeUndefined();
  });

  it("locks the cursor to the held corner's rotate glyph while a rotate drag is in progress, even hovering a scale handle", () => {
    const drag = { kind: "rotate", pointerId: 1, handleX: 1, handleY: -1 } as unknown as NonNullable<MoveState["drag"]>;
    // Exactly on the top-right scale handle — without the fix this would read back a resize
    // cursor, contradicting the rotate gesture the pointer is actually mid-way through.
    const cursor = move.cursorFor!(fakeContext({ pending, drag }), fakePointer(bounds.x + bounds.width, bounds.y));
    expect(cursor).toContain("alias");
    expect(cursor).not.toContain("resize");
    // The drag started on the top-right corner (handleX: 1, handleY: -1), so the locked cursor
    // stays that corner's glyph regardless of where the pointer wanders mid-drag.
    expect(rotateCorner(cursor!)).toBe("TR");
  });

  it("locks the cursor to the held handle's resize glyph while a scale drag is in progress, even hovering the rotate zone", () => {
    const drag = { kind: "scale", pointerId: 1, handleX: 1, handleY: -1 } as unknown as NonNullable<MoveState["drag"]>;
    const cursor = move.cursorFor!(fakeContext({ pending, drag }), fakePointer(bounds.x + bounds.width + 15, bounds.y - 15));
    expect(cursor).toContain("nesw-resize");
  });

  it("locks the cursor to move while an ordinary move drag is in progress", () => {
    const drag = { kind: "move", pointerId: 1 } as unknown as NonNullable<MoveState["drag"]>;
    expect(move.cursorFor!(fakeContext({ pending, drag }), fakePointer(bounds.x + bounds.width, bounds.y))).toBe("move");
  });
});
