import { describe, expect, it } from "vitest";
import { smoothContour, traceAlphaOutlines } from "./scene3d-render";

/**
 * `smoothContour` exists to fix a real reported defect: extruding a pixel
 * layer with a diagonal or curved edge produced a visibly stepped side wall,
 * because `traceAlphaOutlines` only ever walks whole pixel corners. These
 * tests measure the thing that actually matters — how far the traced
 * boundary strays from the true edge it approximates — not just that the
 * function runs.
 */

function maxDeviationFromDiagonal(points: readonly { x: number; y: number }[]): number {
  // Perpendicular distance from the line y = x. The polygon below closes
  // back on itself exactly along that same line, so every point in it —
  // staircase-derived or not — is supposed to stay near the diagonal;
  // nothing to filter out.
  let worst = 0;
  for (const point of points) worst = Math.max(worst, Math.abs(point.x - point.y) / Math.SQRT2);
  return worst;
}

/** A closed polygon that is a pixel-grid staircase approximating the
 * diagonal from (0,0) to (n,n) on the way out, and the diagonal itself
 * (`smoothContour`'s own cyclic wrap from the last point back to the first)
 * on the way back — exactly the one-jagged-edge shape `traceAlphaOutlines`
 * produces for a rasterized triangle whose hypotenuse runs at 45°. */
function staircasePolygon(n: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  for (let i = 1; i <= n; i += 1) {
    points.push({ x: i - 1, y: i });
    points.push({ x: i, y: i });
  }
  return points;
}

describe("smoothContour", () => {
  it("leaves degenerate input (fewer than 3 points) unchanged", () => {
    const input = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(smoothContour(input)).toEqual(input);
  });

  it("returns a copy, not the same array, so the caller's own contour is never mutated later", () => {
    const input = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
    const output = smoothContour(input, 0);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it("reduces a pixel staircase's deviation from the true diagonal it approximates", () => {
    const n = 12;
    const staircase = staircasePolygon(n);
    const before = maxDeviationFromDiagonal(staircase);
    // A one-pixel staircase deviates by half the step size off the true diagonal.
    expect(before).toBeGreaterThan(0.3);

    const smoothed = smoothContour(staircase, 2);
    const after = maxDeviationFromDiagonal(smoothed);
    expect(after).toBeLessThan(before);
    // Not just "less" — meaningfully closer to the true edge, the actual
    // point of doing this at all.
    expect(after).toBeLessThan(before * 0.8);
  });

  it("converges further with more iterations rather than oscillating or diverging", () => {
    const n = 12;
    const staircase = staircasePolygon(n);
    const oneRound = maxDeviationFromDiagonal(smoothContour(staircase, 1));
    const twoRounds = maxDeviationFromDiagonal(smoothContour(staircase, 2));
    const fourRounds = maxDeviationFromDiagonal(smoothContour(staircase, 4));
    expect(twoRounds).toBeLessThanOrEqual(oneRound);
    expect(fourRounds).toBeLessThanOrEqual(twoRounds);
  });

  it("keeps a large right-angle corner recognizably intact rather than rounding it into a curve", () => {
    // A plain square — the kind of shape a rasterized icon's real corner
    // looks like. Two passes of Chaikin should only shave a small corner off
    // each vertex, not erase the square into something round.
    const square = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
    const smoothed = smoothContour(square, 2);
    // Every smoothed point should still be within a small distance of the
    // original square's own boundary (on one of its four edges), not pulled
    // deep into the interior the way aggressive rounding would.
    const distanceToSquareBoundary = (p: { x: number; y: number }) => Math.min(
      p.x, 20 - p.x, p.y, 20 - p.y,
    );
    for (const point of smoothed) {
      // Distance from the point to the nearest edge line, clamped — a point
      // near a corner can be close to two edges' lines but still outside the
      // segment; a generous bound (2.5 units on a 20-unit square) is enough
      // to prove this is corner-shaving, not full rounding.
      expect(Math.abs(distanceToSquareBoundary(point))).toBeLessThan(2.5);
    }
  });

  it("closes back on itself: the smoothed polygon's own last-to-first edge is the same kind of segment as every other", () => {
    const staircase = staircasePolygon(6);
    const smoothed = smoothContour(staircase, 1);
    // Chaikin on a closed loop produces exactly 2 points per input edge.
    expect(smoothed.length).toBe(staircase.length * 2);
  });
});

/**
 * §65.9 — a layer of separate letters extruded only its first letter, and holes were filled in.
 */
describe("traceAlphaOutlines", () => {
  const W = 40, H = 30;
  const paint = (cells: (x: number, y: number) => boolean) => {
    const pixels = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (cells(x, y)) pixels[(y * W + x) * 4 + 3] = 255;
    return pixels;
  };
  const box = (points: readonly { x: number; y: number }[]) => ({
    x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)),
    right: Math.max(...points.map((p) => p.x)), bottom: Math.max(...points.map((p) => p.y)),
  });

  it("traces a solid square as one outline on its pixel corners, four corners only", () => {
    const outlines = traceAlphaOutlines(paint((x, y) => x >= 5 && x < 15 && y >= 5 && y < 15), W, H);
    expect(outlines).toHaveLength(1);
    expect(outlines[0]!.outer).toHaveLength(4);
    expect(box(outlines[0]!.outer)).toEqual({ x: 5, y: 5, right: 15, bottom: 15 });
    expect(outlines[0]!.holes).toEqual([]);
  });

  it("keeps every separate part, not only the first one found", () => {
    const outlines = traceAlphaOutlines(paint((x, y) => y >= 5 && y < 15 && ((x >= 2 && x < 8) || (x >= 12 && x < 18) || (x >= 25 && x < 35))), W, H);
    expect(outlines.map((outline) => box(outline.outer).x).sort((a, b) => a - b)).toEqual([2, 12, 25]);
  });

  it("gives a ring its hole instead of filling it", () => {
    const ring = (x: number, y: number) => x >= 5 && x < 25 && y >= 5 && y < 25 && !(x >= 10 && x < 20 && y >= 10 && y < 20);
    const outlines = traceAlphaOutlines(paint(ring), W, H);
    expect(outlines).toHaveLength(1);
    expect(outlines[0]!.holes).toHaveLength(1);
    expect(box(outlines[0]!.holes[0]!)).toEqual({ x: 10, y: 10, right: 20, bottom: 20 });
  });

  it("treats an island inside a hole as its own part, with the hole still on the ring", () => {
    const cells = (x: number, y: number) => (x >= 2 && x < 28 && y >= 2 && y < 28 && !(x >= 6 && x < 24 && y >= 6 && y < 24)) || (x >= 12 && x < 18 && y >= 12 && y < 18);
    const outlines = traceAlphaOutlines(paint(cells), W, H);
    expect(outlines).toHaveLength(2);
    const ring = outlines.find((outline) => box(outline.outer).x === 2)!;
    const island = outlines.find((outline) => box(outline.outer).x === 12)!;
    expect(ring.holes).toHaveLength(1);
    expect(island.holes).toEqual([]);
  });

  it("keeps two pixels touching only at a corner as two parts", () => {
    const outlines = traceAlphaOutlines(paint((x, y) => (x >= 4 && x < 8 && y >= 4 && y < 8) || (x >= 8 && x < 12 && y >= 8 && y < 12)), W, H);
    expect(outlines).toHaveLength(2);
    for (const outline of outlines) expect(outline.outer).toHaveLength(4);
  });

  it("drops specks smaller than the minimum area and returns nothing for a transparent layer", () => {
    expect(traceAlphaOutlines(paint((x, y) => x === 3 && y === 3), W, H)).toEqual([]);
    expect(traceAlphaOutlines(new Uint8ClampedArray(W * H * 4), W, H)).toEqual([]);
  });
});
