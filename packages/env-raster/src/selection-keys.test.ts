import { describe, expect, it } from "vitest";
import { createRectangleSelection, featherSelection, marqueeCorners, marqueeRect, selectionBounds } from "./index";

describe("marquee modifiers", () => {
  it("follows the pointer when nothing is held", () => {
    expect(marqueeCorners(10, 20, 40, 25)).toEqual({ fromX: 10, fromY: 20, toX: 40, toY: 25 });
  });

  it("squares off to the longer side, keeping the direction", () => {
    // Taking the shorter side would collapse the shape toward whichever axis
    // moved least, which fights the hand rather than following it.
    expect(marqueeCorners(10, 10, 40, 20, { square: true })).toEqual({ fromX: 10, fromY: 10, toX: 40, toY: 40 });
    expect(marqueeCorners(10, 10, -20, 5, { square: true })).toEqual({ fromX: 10, fromY: 10, toX: -20, toY: -20 });
  });

  it("grows from the start point in both directions", () => {
    expect(marqueeCorners(50, 50, 60, 70, { fromCentre: true })).toEqual({ fromX: 40, fromY: 30, toX: 60, toY: 70 });
  });

  it("combines a square with drawing from the centre", () => {
    const corners = marqueeCorners(50, 50, 70, 55, { square: true, fromCentre: true });

    expect(corners).toEqual({ fromX: 30, fromY: 30, toX: 70, toY: 70 });
  });

  it("reports the same shape as a normalized rectangle", () => {
    expect(marqueeRect(40, 40, 10, 20)).toEqual({ x: 10, y: 20, width: 30, height: 20 });
    expect(marqueeRect(50, 50, 60, 70, { fromCentre: true })).toEqual({ x: 40, y: 30, width: 20, height: 40 });
  });

  it("has no extent when the pointer has not moved", () => {
    expect(marqueeRect(10, 10, 10, 10, { square: true })).toEqual({ x: 10, y: 10, width: 0, height: 0 });
  });
});

describe("feathering a selection", () => {
  const W = 40, H = 40;
  const block = () => createRectangleSelection(W, H, 12, 12, 28, 28);
  const at = (mask: Uint8ClampedArray, x: number, y: number) => mask[y * W + x]!;

  it("returns a copy rather than the original at radius zero", () => {
    const source = block();

    const result = featherSelection(source, W, H, 0)!;

    expect(result.mask).not.toBe(source.mask);
    expect([...result.mask]).toEqual([...source.mask]);
  });

  it("softens the edge without moving the middle", () => {
    const feathered = featherSelection(block(), W, H, 3)!;

    // Solid in the interior, partial across the border, nothing far outside.
    expect(at(feathered.mask, 20, 20)).toBe(255);
    expect(at(feathered.mask, 12, 20)).toBeGreaterThan(0);
    expect(at(feathered.mask, 12, 20)).toBeLessThan(255);
    expect(at(feathered.mask, 4, 20)).toBe(0);
  });

  it("spreads the edge wider as the radius grows", () => {
    const narrow = featherSelection(block(), W, H, 2)!;
    const wide = featherSelection(block(), W, H, 5)!;

    expect(wide.bounds.width).toBeGreaterThan(narrow.bounds.width);
    expect(at(wide.mask, 8, 20)).toBeGreaterThan(at(narrow.mask, 8, 20));
  });

  it("keeps the softened edge symmetric", () => {
    const feathered = featherSelection(block(), W, H, 4)!;

    // An asymmetric blur pulls the selection off centre, which shows up as a
    // shape that has drifted after every feather.
    expect(at(feathered.mask, 10, 20)).toBe(at(feathered.mask, 29, 20));
    expect(at(feathered.mask, 20, 10)).toBe(at(feathered.mask, 20, 29));
  });

  it("reports bounds that match the softened mask", () => {
    const feathered = featherSelection(block(), W, H, 3)!;

    expect(feathered.bounds).toEqual(selectionBounds(feathered.mask, W, H));
  });

  it("passes nothing through as nothing", () => {
    expect(featherSelection(null, W, H, 4)).toBeNull();
  });
});
