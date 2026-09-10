import { describe, expect, it } from "vitest";
import { fillEnclosedHoles } from "./selection";

const W = 20, H = 20;

function empty(): Uint8ClampedArray {
  return new Uint8ClampedArray(W * H);
}

/** A hollow square ring: walls all the way around a hole. */
function ring(left: number, top: number, right: number, bottom: number): Uint8ClampedArray {
  const mask = empty();
  for (let x = left; x <= right; x += 1) { mask[top * W + x] = 255; mask[bottom * W + x] = 255; }
  for (let y = top; y <= bottom; y += 1) { mask[y * W + left] = 255; mask[y * W + right] = 255; }
  return mask;
}

function at(mask: Uint8ClampedArray, x: number, y: number): number {
  return mask[y * W + x]!;
}

describe("fillEnclosedHoles", () => {
  it("fills the hole inside a closed ring", () => {
    const mask = ring(4, 4, 14, 14);
    expect(at(mask, 9, 9)).toBe(0);
    const filled = fillEnclosedHoles(mask, W, H);
    expect(at(filled, 9, 9)).toBe(255);
    // The ring itself is unchanged.
    expect(at(filled, 4, 9)).toBe(255);
    // Outside the ring stays unselected.
    expect(at(filled, 1, 1)).toBe(0);
  });

  it("leaves an all-empty mask alone — nothing walls anything off", () => {
    const filled = fillEnclosedHoles(empty(), W, H);
    expect([...filled].every((value) => value === 0)).toBe(true);
  });

  it("does not fill a ring that is open to the canvas edge — the hole is connected to the outside", () => {
    const mask = ring(4, 4, 14, 14);
    // Break the ring's own bottom edge.
    mask[14 * W + 9] = 0;
    const filled = fillEnclosedHoles(mask, W, H);
    // The interior is now reachable from outside through the gap, so it stays empty.
    expect(at(filled, 9, 9)).toBe(0);
  });

  it("fills more than one separate hole", () => {
    const mask = new Uint8ClampedArray(W * H);
    const first = ring(1, 1, 5, 5), second = ring(10, 10, 17, 17);
    for (let i = 0; i < mask.length; i += 1) mask[i] = Math.max(first[i]!, second[i]!);
    const filled = fillEnclosedHoles(mask, W, H);
    expect(at(filled, 3, 3)).toBe(255);
    expect(at(filled, 13, 13)).toBe(255);
  });

  it("treats any nonzero value as a wall, including a soft brush edge below full coverage", () => {
    const mask = ring(4, 4, 14, 14);
    // Soften the ring to partial coverage, the way a brush's own edge would.
    for (let i = 0; i < mask.length; i += 1) if (mask[i]) mask[i] = 40;
    const filled = fillEnclosedHoles(mask, W, H);
    expect(at(filled, 9, 9)).toBe(255);
  });

  it("does not mutate the input mask", () => {
    const mask = ring(4, 4, 14, 14);
    const before = mask.slice();
    fillEnclosedHoles(mask, W, H);
    expect([...mask]).toEqual([...before]);
  });
});
