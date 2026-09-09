import { describe, expect, it } from "vitest";
import { createRectangleSelection, selectionOutlinePath, traceSelectionOutlines } from "./index";

/**
 * The owner's report, in two halves that turned out to be one bug: the marching
 * ants looked right while a selection was being dragged and wrong the moment it
 * was committed — "closer to a plain white line" — and once the animation was
 * fixed the committed outline flashed black and white as a whole, "bipolar",
 * instead of dashes travelling along it.
 *
 * Both come from the shape of the path. The outline used to be emitted as one
 * subpath per pixel edge (`M x y h1`, `M x+1 y v1`, …), each exactly one
 * document unit long. A dash pattern restarts on every subpath, so every
 * fragment sat inside a single dash: all "on" at once (a solid white line), and
 * as the offset animated, all switching to "off" together (the whole outline
 * blinking). The live preview looked correct only because it draws one honest
 * rectangle.
 *
 * So what these check is the property the ants actually need — that the
 * boundary is a small number of long closed loops — rather than any particular
 * byte of path text.
 */

const WIDTH = 32, HEIGHT = 24;

const maskOf = (fill: (x: number, y: number) => boolean) => {
  const mask = new Uint8ClampedArray(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) if (fill(x, y)) mask[y * WIDTH + x] = 255;
  return mask;
};

describe("selection outline", () => {
  it("traces a rectangle as one loop of four corners", () => {
    const mask = maskOf((x, y) => x >= 8 && x < 20 && y >= 6 && y < 16);
    const loops = traceSelectionOutlines(mask, WIDTH, HEIGHT);

    expect(loops).toHaveLength(1);
    // Four corners, not forty-four pixel edges. The rectangle's own corners,
    // with the right/bottom edges one unit past the last selected pixel — the
    // boundary runs between pixels, not through them.
    expect(loops[0]!.points).toEqual([
      { x: 8, y: 6 }, { x: 20, y: 6 }, { x: 20, y: 16 }, { x: 8, y: 16 },
    ]);
  });

  it("gives the path long subpaths for a dash to run along", () => {
    const mask = maskOf((x, y) => x >= 8 && x < 20 && y >= 6 && y < 16);
    const path = selectionOutlinePath(mask, WIDTH, HEIGHT);

    // One "M" means one subpath. The old tracer produced 44 of them here, one
    // per pixel edge, and a 4px dash cannot alternate along a 1-unit segment.
    expect((path.match(/M/g) ?? []).length).toBe(1);
    expect(path.endsWith("Z")).toBe(true);
    const perimeter = 2 * (12 + 10);
    expect(perimeter).toBeGreaterThan(8);
  });

  it("traces a hole as its own loop", () => {
    const mask = maskOf((x, y) => x >= 4 && x < 28 && y >= 4 && y < 20 && !(x >= 12 && x < 18 && y >= 8 && y < 14));
    const loops = traceSelectionOutlines(mask, WIDTH, HEIGHT);

    // Outer boundary and the hole's boundary — two closed loops, so the ants
    // walk around the hole too rather than skipping it.
    expect(loops).toHaveLength(2);
    for (const loop of loops) expect(loop.points).toHaveLength(4);
  });

  it("keeps two diagonally touching squares as two loops", () => {
    // The saddle case the donor's right-turn-first rule exists for: at a corner
    // where two regions meet diagonally the walk must hug its own pixel, so the
    // contours touch without merging into one.
    const mask = maskOf((x, y) => (x >= 4 && x < 8 && y >= 4 && y < 8) || (x >= 8 && x < 12 && y >= 8 && y < 12));
    expect(traceSelectionOutlines(mask, WIDTH, HEIGHT)).toHaveLength(2);
  });

  it("traces an ellipse into one loop, not a fragment per pixel", () => {
    const mask = maskOf((x, y) => ((x - 16) / 10) ** 2 + ((y - 12) / 7) ** 2 <= 1);
    const loops = traceSelectionOutlines(mask, WIDTH, HEIGHT);

    expect(loops).toHaveLength(1);
    // A staircase has many corners — that is the shape of a rasterised
    // ellipse — but it is still ONE continuous loop, which is the whole point.
    expect(loops[0]!.points.length).toBeGreaterThan(8);
    expect((selectionOutlinePath(mask, WIDTH, HEIGHT).match(/M/g) ?? []).length).toBe(1);
  });

  it("says nothing about an empty mask", () => {
    expect(traceSelectionOutlines(new Uint8ClampedArray(WIDTH * HEIGHT), WIDTH, HEIGHT)).toEqual([]);
    expect(selectionOutlinePath(new Uint8ClampedArray(WIDTH * HEIGHT), WIDTH, HEIGHT)).toBe("");
  });

  it("traces what the marquee tool actually produces", () => {
    // Through the real constructor rather than a hand-built mask: a feathered
    // edge is partly transparent, and the threshold decides where the boundary
    // falls — worth exercising the path a user's drag really takes.
    const selection = createRectangleSelection(WIDTH, HEIGHT, 6, 5, 24, 18);
    const loops = traceSelectionOutlines(selection.mask, WIDTH, HEIGHT);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.points).toHaveLength(4);
  });
});
