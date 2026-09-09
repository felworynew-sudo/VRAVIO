import { describe, expect, it } from "vitest";
import { constrainToAxis, rectBetween, rectsOverlap, resolveMarqueeRelease, resolveSelectionPress } from "./selection-rules";

/**
 * The rules, checked as rules. Each case below is one sentence from how
 * Photoshop's Move tool actually behaves (researched, see selection-rules.ts) —
 * written this way because the owner asked for that behaviour specifically, and
 * a rule stated in a comment is not a rule anything holds to.
 */

describe("clicking", () => {
  it("selects what was clicked", () => {
    expect(resolveSelectionPress("a", [], false)).toEqual({ selection: ["a"], drag: true });
    expect(resolveSelectionPress("b", ["a"], false)).toEqual({ selection: ["b"], drag: true });
  });

  it("drags the whole selection when one of its members is clicked", () => {
    // Not "collapse to the clicked one" — clicking inside a multiple selection
    // and dragging moves all of it, which is the behaviour that makes selecting
    // several objects worth anything.
    expect(resolveSelectionPress("b", ["a", "b", "c"], false)).toEqual({ selection: ["a", "b", "c"], drag: true });
  });

  it("leaves the selection alone when the click misses", () => {
    // A miss starts a band; what happens to the selection is decided when the
    // band comes up, not here.
    expect(resolveSelectionPress(null, ["a"], false)).toEqual({ selection: ["a"], drag: false });
  });
});

describe("shift-clicking", () => {
  it("adds an unselected object", () => {
    expect(resolveSelectionPress("b", ["a"], true)).toEqual({ selection: ["a", "b"], drag: true });
  });

  it("removes one that was already selected", () => {
    expect(resolveSelectionPress("b", ["a", "b"], true)).toEqual({ selection: ["a"], drag: false });
  });

  it("takes the same object in and out again", () => {
    // The owner's "one object can be selected twice": shift-click adds, and
    // shift-clicking it again takes it back out.
    const added = resolveSelectionPress("b", ["a"], true).selection;
    expect(added).toEqual(["a", "b"]);
    expect(resolveSelectionPress("b", added, true).selection).toEqual(["a"]);
  });

  it("will not empty the selection", () => {
    // Photoshop keeps the last one selected rather than letting Shift-click
    // leave nothing behind.
    expect(resolveSelectionPress("a", ["a"], true)).toEqual({ selection: ["a"], drag: true });
  });
});

describe("the rubber band", () => {
  it("replaces the selection with what it caught", () => {
    expect(resolveMarqueeRelease(["b", "c"], ["a"], false)).toEqual(["b", "c"]);
  });

  it("clears the selection when it catches nothing", () => {
    expect(resolveMarqueeRelease([], ["a", "b"], false)).toEqual([]);
  });

  it("adds to the selection when held with Shift", () => {
    expect(resolveMarqueeRelease(["b", "c"], ["a"], true)).toEqual(["a", "b", "c"]);
  });

  it("does not list an object twice when Shift-banding over it again", () => {
    expect(resolveMarqueeRelease(["a", "b"], ["a"], true)).toEqual(["a", "b"]);
  });

  it("catches what it touches, not only what it encloses", () => {
    const band = { x: 10, y: 10, width: 20, height: 20 };
    // Straddling the band's edge — caught, the rule both Photoshop and
    // Illustrator use, and the one that makes a band swept across a row pick
    // the whole row up.
    expect(rectsOverlap(band, { x: 25, y: 25, width: 40, height: 40 })).toBe(true);
    // Fully inside — caught.
    expect(rectsOverlap(band, { x: 12, y: 12, width: 4, height: 4 })).toBe(true);
    // Clear of it — not caught.
    expect(rectsOverlap(band, { x: 40, y: 40, width: 5, height: 5 })).toBe(false);
    // Touching exactly at the corner still counts as touching.
    expect(rectsOverlap(band, { x: 30, y: 30, width: 5, height: 5 })).toBe(true);
  });

  it("is the same rectangle dragged in any direction", () => {
    expect(rectBetween({ x: 30, y: 40 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 20, height: 20 });
    expect(rectBetween({ x: 10, y: 20 }, { x: 30, y: 40 })).toEqual({ x: 10, y: 20, width: 20, height: 20 });
  });
});

describe("shift while dragging", () => {
  it("keeps the move on one axis, the longer one", () => {
    expect(constrainToAxis(30, 4, true)).toEqual({ x: 30, y: 0 });
    expect(constrainToAxis(4, -30, true)).toEqual({ x: 0, y: -30 });
  });

  it("leaves an unmodified drag alone", () => {
    expect(constrainToAxis(30, 4, false)).toEqual({ x: 30, y: 4 });
  });
});
