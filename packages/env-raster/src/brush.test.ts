import { describe, expect, it } from "vitest";
import { drawDab, drawQuadraticStrokeSegment } from "./paint";

/**
 * The owner's report: a freehand stroke "очень жёстко тупит" while a Shift-straight line "летает",
 * and hardness behaves oddly.
 *
 * Both had the same root: the brush obeyed its spacing only when it was handed the whole path at
 * once. A freehand stroke arrives as a stream of pointer samples a few pixels apart — every
 * coalesced sample the browser buffered — and the segment painter used
 * `steps = max(1, length / spacing)`, so each of those got a dab of its own no matter how close
 * together they were. With a 600px brush that is one dab every 3px where the spacing asks for one
 * every 72px: twenty-four times the work, and a stroke whose density followed the speed of the
 * hand rather than the distance it covered.
 *
 * Nothing here pinned that before, which is why the whole suite stayed green through the fault.
 */

const W = 400, H = 200;
const BLACK = { r: 0, g: 0, b: 0, a: 255 };

function blank(): Uint8ClampedArray {
  return new Uint8ClampedArray(W * H * 4);
}

/** How many pixels the stroke actually marked. */
function painted(pixels: Uint8ClampedArray): number {
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! > 0) count += 1;
  return count;
}

/** Alpha along a horizontal cut through a dab's centre. */
function rowAlpha(pixels: Uint8ClampedArray, y: number): number[] {
  const row: number[] = [];
  for (let x = 0; x < W; x += 1) row.push(pixels[(y * W + x) * 4 + 3]!);
  return row;
}

describe("brush spacing", () => {
  it("lays the same stroke whether the path arrives in one piece or in many", () => {
    // The complaint, as an equality. A straight line drawn as one call and the same line fed in
    // 3px pointer samples have to come out the same picture — before the spacing carry, the
    // second was far darker and far slower.
    const size = 60;
    const whole = blank();
    drawQuadraticStrokeSegment(whole, W, H, { x: 40, y: 100 }, { x: 160, y: 100 }, { x: 280, y: 100 }, size, BLACK, 1, false, undefined, 0.82, 0.12, 1, 0, false, false, 0);

    const piecemeal = blank();
    let carry = 0, from = { x: 40, y: 100 };
    for (let step = 1; step <= 80; step += 1) {
      const to = { x: 40 + step * 3, y: 100 };
      const control = { x: (from.x + to.x) / 2, y: 100 };
      carry = drawQuadraticStrokeSegment(piecemeal, W, H, from, control, to, size, BLACK, 1, false, undefined, 0.82, 0.12, 1, 0, false, false, carry);
      from = to;
    }

    // Same coverage to within one dab's worth of edge — the dabs land at the same spacing, so the
    // painted area matches; it is not asserted pixel-identical because the two paths place their
    // dabs at different offsets along the same line.
    expect(Math.abs(painted(piecemeal) - painted(whole))).toBeLessThan(painted(whole) * 0.05);
  });

  it("does not lay more paint just because the hand moved slowly", () => {
    // The same 240px of travel, sampled coarsely and finely. A dab-per-sample brush paints many
    // times more in the fine case; a spaced one paints the same.
    const size = 40;
    const run = (sampleLength: number) => {
      const pixels = blank();
      let carry = 0, from = { x: 40, y: 100 };
      const samples = Math.round(240 / sampleLength);
      for (let step = 1; step <= samples; step += 1) {
        const to = { x: 40 + step * sampleLength, y: 100 };
        const control = { x: (from.x + to.x) / 2, y: 100 };
        carry = drawQuadraticStrokeSegment(pixels, W, H, from, control, to, size, BLACK, 1, false, undefined, 0.82, 0.12, 1, 0, false, false, carry);
        from = to;
      }
      return painted(pixels);
    };
    const coarse = run(24), fine = run(2);
    expect(Math.abs(fine - coarse)).toBeLessThan(coarse * 0.05);
  });

  it("keeps the leftover distance rather than restarting at each piece", () => {
    // A call too short to reach the next dab must paint nothing and hand the distance on, or the
    // spacing quietly resets on every sample — the same fault in a subtler form.
    const size = 100; // spacing 12% → a dab every 12px
    const pixels = blank();
    const carry = drawQuadraticStrokeSegment(pixels, W, H, { x: 100, y: 100 }, { x: 102, y: 100 }, { x: 104, y: 100 }, size, BLACK, 1, false, undefined, 0.82, 0.12, 1, 0, false, false, 0);
    expect(painted(pixels)).toBe(0);
    expect(carry).toBeGreaterThan(3.5);
    expect(carry).toBeLessThan(4.5);
  });
});

describe("brush hardness", () => {
  it("fades over the whole radius when soft and only at the rim when hard", () => {
    // GIMP's own curve (`gimpbrushgenerated.c`): the hardness enters as the exponent
    // `0.4 / (1 - hardness)` on the normalised distance. A soft brush starts fading at once; a
    // hard one holds full coverage nearly to the edge.
    const soft = blank(), hard = blank();
    drawDab(soft, W, H, { x: 200, y: 100 }, 80, BLACK, 1, false, 0);
    drawDab(hard, W, H, { x: 200, y: 100 }, 80, BLACK, 1, false, 0.95);

    // Half way out from the centre, the soft brush has already given up a lot and the hard one
    // has given up almost nothing.
    const halfway = 200 + 20;
    expect(soft[(100 * W + halfway) * 4 + 3]!).toBeLessThan(200);
    expect(hard[(100 * W + halfway) * 4 + 3]!).toBeGreaterThan(240);
  });

  it("still antialiases the rim at full hardness", () => {
    // The old linear falloff stepped from opaque straight to nothing at hardness 1, so a hard
    // brush had a jagged edge. GIMP avoids it by oversampling its lookup table; this does it with
    // a one-pixel edge ramp, and either way the rim must hold values that are neither 0 nor 255.
    const pixels = blank();
    drawDab(pixels, W, H, { x: 200, y: 100 }, 60, BLACK, 1, false, 1);
    const partial = rowAlpha(pixels, 100).filter((alpha) => alpha > 0 && alpha < 255);
    expect(partial.length).toBeGreaterThan(0);
  });

  it("never brightens as it goes outward, at any hardness", () => {
    // Monotonic falloff — a curve that rises again anywhere would show as a ring.
    for (const hardness of [0, 0.25, 0.5, 0.82, 1]) {
      const pixels = blank();
      drawDab(pixels, W, H, { x: 200, y: 100 }, 90, BLACK, 1, false, hardness);
      const row = rowAlpha(pixels, 100).slice(200);
      for (let index = 1; index < row.length; index += 1) {
        expect(row[index]!, `hardness ${hardness} rose at +${index}`).toBeLessThanOrEqual(row[index - 1]! + 1);
      }
    }
  });

  it("is at its strongest in the middle, and opaque there once it is not extremely soft", () => {
    // Not "opaque at any hardness": GIMP's exponent is 0.4 at hardness 0, and `pow(u, 0.4)` has
    // infinite slope at the centre, so the softest brush has no flat opaque core at all. That is
    // what soft *means*, and asserting otherwise was this test's own mistake, not the curve's.
    for (const hardness of [0, 0.5, 1]) {
      const pixels = blank();
      drawDab(pixels, W, H, { x: 200, y: 100 }, 60, BLACK, 1, false, hardness);
      const row = rowAlpha(pixels, 100);
      const centre = row[200]!;
      expect(Math.max(...row), `hardness ${hardness}`).toBe(centre);
      if (hardness >= 0.5) expect(centre, `hardness ${hardness}`).toBeGreaterThan(250);
    }
  });

  it("pulls the half-coverage point inward the softer it gets", () => {
    // The owner asked for a feathering range like the donors'. The honest measure of "softer" is
    // where coverage falls to half: a hard brush holds half-coverage out to the rim, a soft one
    // gives it up near the centre. (Counting partly-covered columns instead reads *backwards* at
    // the soft end, because most of a very soft brush lies below any visibility threshold — the
    // first version of this test measured exactly that and called the softest brush the hardest.)
    const halfRadius = (hardness: number) => {
      const pixels = blank();
      drawDab(pixels, W, H, { x: 200, y: 100 }, 90, BLACK, 1, false, hardness);
      const row = rowAlpha(pixels, 100);
      for (let x = 200; x < W; x += 1) if (row[x]! < 128) return x - 200;
      return W;
    };
    expect(halfRadius(0)).toBeLessThan(halfRadius(0.5));
    expect(halfRadius(0.5)).toBeLessThan(halfRadius(0.95));
    // And the hardest brush keeps its coverage essentially to the edge — a 90px brush is 45
    // across, so half coverage must survive most of the way out.
    expect(halfRadius(0.95)).toBeGreaterThan(38);
  });
});
