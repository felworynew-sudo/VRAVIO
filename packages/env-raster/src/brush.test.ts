import { describe, expect, it } from "vitest";
import { accumulateDab, accumulateStrokeSegment, compositeCoverage } from "./paint";

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

/** A stroke's coverage mask, which is where the dabs land before anything is composited. */
function blankCoverage(): Uint8ClampedArray {
  return new Uint8ClampedArray(W * H);
}

/** How many pixels the stroke actually marked. */
function painted(coverage: Uint8ClampedArray): number {
  let count = 0;
  for (let index = 0; index < coverage.length; index += 1) if (coverage[index]! > 0) count += 1;
  return count;
}

/** Coverage along a horizontal cut through a dab's centre. */
function rowAlpha(coverage: Uint8ClampedArray, y: number): number[] {
  const row: number[] = [];
  for (let x = 0; x < W; x += 1) row.push(coverage[y * W + x]!);
  return row;
}

describe("brush spacing", () => {
  it("lays the same stroke whether the path arrives in one piece or in many", () => {
    // The complaint, as an equality. A straight line drawn as one call and the same line fed in
    // 3px pointer samples have to come out the same picture — before the spacing carry, the
    // second was far darker and far slower.
    const size = 60;
    const whole = blankCoverage();
    accumulateStrokeSegment(whole, W, H, { x: 40, y: 100 }, { x: 160, y: 100 }, { x: 280, y: 100 }, size, 1, 1, undefined, 0.82, 0.12, 1, 0, false, false, 0);

    const piecemeal = blankCoverage();
    let carry = 0, from = { x: 40, y: 100 };
    for (let step = 1; step <= 80; step += 1) {
      const to = { x: 40 + step * 3, y: 100 };
      const control = { x: (from.x + to.x) / 2, y: 100 };
      carry = accumulateStrokeSegment(piecemeal, W, H, from, control, to, size, 1, 1, undefined, 0.82, 0.12, 1, 0, false, false, carry);
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
      const coverage = blankCoverage();
      let carry = 0, from = { x: 40, y: 100 };
      const samples = Math.round(240 / sampleLength);
      for (let step = 1; step <= samples; step += 1) {
        const to = { x: 40 + step * sampleLength, y: 100 };
        const control = { x: (from.x + to.x) / 2, y: 100 };
        carry = accumulateStrokeSegment(coverage, W, H, from, control, to, size, 1, 1, undefined, 0.82, 0.12, 1, 0, false, false, carry);
        from = to;
      }
      return painted(coverage);
    };
    const coarse = run(24), fine = run(2);
    expect(Math.abs(fine - coarse)).toBeLessThan(coarse * 0.05);
  });

  it("keeps the leftover distance rather than restarting at each piece", () => {
    // A call too short to reach the next dab must paint nothing and hand the distance on, or the
    // spacing quietly resets on every sample — the same fault in a subtler form.
    const size = 100; // spacing 12% → a dab every 12px
    const coverage = blankCoverage();
    const carry = accumulateStrokeSegment(coverage, W, H, { x: 100, y: 100 }, { x: 102, y: 100 }, { x: 104, y: 100 }, size, 1, 1, undefined, 0.82, 0.12, 1, 0, false, false, 0);
    expect(painted(coverage)).toBe(0);
    expect(carry).toBeGreaterThan(3.5);
    expect(carry).toBeLessThan(4.5);
  });
});

describe("brush hardness", () => {
  it("fades over the whole radius when soft and only at the rim when hard", () => {
    // GIMP's own curve (`gimpbrushgenerated.c`): the hardness enters as the exponent
    // `0.4 / (1 - hardness)` on the normalised distance. A soft brush starts fading at once; a
    // hard one holds full coverage nearly to the edge.
    const soft = blankCoverage(), hard = blankCoverage();
    accumulateDab(soft, W, H, { x: 200, y: 100 }, 80, 1, 1, 0);
    accumulateDab(hard, W, H, { x: 200, y: 100 }, 80, 1, 1, 0.95);

    // Half way out from the centre, the soft brush has already given up a lot and the hard one
    // has given up almost nothing.
    const halfway = 200 + 20;
    expect(soft[100 * W + halfway]!).toBeLessThan(200);
    expect(hard[100 * W + halfway]!).toBeGreaterThan(240);
  });

  it("still antialiases the rim at full hardness", () => {
    // The old linear falloff stepped from opaque straight to nothing at hardness 1, so a hard
    // brush had a jagged edge. GIMP avoids it by oversampling its lookup table; this does it with
    // a one-pixel edge ramp, and either way the rim must hold values that are neither 0 nor 255.
    const coverage = blankCoverage();
    accumulateDab(coverage, W, H, { x: 200, y: 100 }, 60, 1, 1, 1);
    const partial = rowAlpha(coverage, 100).filter((alpha) => alpha > 0 && alpha < 255);
    expect(partial.length).toBeGreaterThan(0);
  });

  it("never brightens as it goes outward, at any hardness", () => {
    // Monotonic falloff — a curve that rises again anywhere would show as a ring.
    for (const hardness of [0, 0.25, 0.5, 0.82, 1]) {
      const coverage = blankCoverage();
      accumulateDab(coverage, W, H, { x: 200, y: 100 }, 90, 1, 1, hardness);
      const row = rowAlpha(coverage, 100).slice(200);
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
      const coverage = blankCoverage();
      accumulateDab(coverage, W, H, { x: 200, y: 100 }, 60, 1, 1, hardness);
      const row = rowAlpha(coverage, 100);
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
      const coverage = blankCoverage();
      accumulateDab(coverage, W, H, { x: 200, y: 100 }, 90, 1, 1, hardness);
      const row = rowAlpha(coverage, 100);
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

describe("stroke coverage", () => {
  const WHITE_BASE = () => {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255; }
    return px;
  };
  const valueAt = (px: Uint8ClampedArray, x: number, y: number) => px[(y * W + x) * 4]!;

  it("holds a stroke to its opacity instead of building past it", () => {
    // The fault this replaced: dabs land about eight deep at the default spacing, and compositing
    // each one separately compounds them — 1 − 0.5^8 ≈ 0.996. A "50%" stroke came out at 5 of 255,
    // which is to say black, and the opacity setting meant nothing at all.
    //
    // Photoshop treats opacity as a ceiling for the whole stroke and flow as how fast each dab
    // approaches it; that is only expressible if the dabs accumulate into one mask first.
    const coverage = new Uint8ClampedArray(W * H);
    accumulateStrokeSegment(coverage, W, H, { x: 40, y: 100 }, { x: 150, y: 100 }, { x: 260, y: 100 }, 50, 1, 0.5, undefined, 0.82, 0.12, 1, 0, false, false, 0);
    const painted = WHITE_BASE();
    compositeCoverage(painted, WHITE_BASE(), coverage, W, H, { x: 0, y: 60, width: W, height: 80 }, BLACK, false);

    // Mid-band, well inside the stroke: half way between white and black, not black.
    expect(valueAt(painted, 150, 100)).toBeGreaterThan(110);
    expect(valueAt(painted, 150, 100)).toBeLessThan(145);
  });

  it("does not darken where a stroke crosses itself", () => {
    // The same property seen from the other side, and the one a user notices first.
    const coverage = new Uint8ClampedArray(W * H);
    const carry = accumulateStrokeSegment(coverage, W, H, { x: 60, y: 60 }, { x: 150, y: 100 }, { x: 240, y: 140 }, 40, 1, 0.5, undefined, 0.82, 0.12, 1, 0, false, false, 0);
    accumulateStrokeSegment(coverage, W, H, { x: 240, y: 60 }, { x: 150, y: 100 }, { x: 60, y: 140 }, 40, 1, 0.5, undefined, 0.82, 0.12, 1, 0, false, false, carry);
    const painted = WHITE_BASE();
    compositeCoverage(painted, WHITE_BASE(), coverage, W, H, { x: 0, y: 0, width: W, height: H }, BLACK, false);

    const arm = valueAt(painted, 100, 80), crossing = valueAt(painted, 150, 100);
    expect(Math.abs(crossing - arm)).toBeLessThan(12);
  });

  it("still reaches full black at full opacity", () => {
    // The ceiling must not become a cap that can never be met.
    const coverage = new Uint8ClampedArray(W * H);
    accumulateStrokeSegment(coverage, W, H, { x: 40, y: 100 }, { x: 150, y: 100 }, { x: 260, y: 100 }, 50, 1, 1, undefined, 0.82, 0.12, 1, 0, false, false, 0);
    const painted = WHITE_BASE();
    compositeCoverage(painted, WHITE_BASE(), coverage, W, H, { x: 0, y: 60, width: W, height: 80 }, BLACK, false);
    expect(valueAt(painted, 150, 100)).toBeLessThan(4);
  });

  it("builds up gradually when flow is low, and still stops at the ceiling", () => {
    // Flow is the rate, opacity the ceiling: a low flow needs several passes to get there and
    // never goes past.
    const coverage = new Uint8ClampedArray(W * H);
    const readings: number[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      accumulateStrokeSegment(coverage, W, H, { x: 40, y: 100 }, { x: 150, y: 100 }, { x: 260, y: 100 }, 50, 0.15, 0.6, undefined, 0.82, 0.12, 1, 0, false, false, 0);
      readings.push(coverage[100 * W + 150]!);
    }
    expect(readings[0]!).toBeLessThan(readings[2]!);
    expect(readings[5]!).toBeLessThanOrEqual(Math.round(0.6 * 255) + 1);
  });

  it("laying the same band twice does not paint it twice", () => {
    // Every frame recomposites the band it touched, from the untouched `before`. If that built on
    // the previous frame instead, a slow stroke would come out darker than a quick one — the same
    // class of fault as the spacing one, on the compositing side.
    const coverage = new Uint8ClampedArray(W * H);
    accumulateStrokeSegment(coverage, W, H, { x: 40, y: 100 }, { x: 150, y: 100 }, { x: 260, y: 100 }, 50, 1, 0.5, undefined, 0.82, 0.12, 1, 0, false, false, 0);
    const base = WHITE_BASE();
    const once = WHITE_BASE();
    compositeCoverage(once, base, coverage, W, H, { x: 0, y: 60, width: W, height: 80 }, BLACK, false);
    const twice = WHITE_BASE();
    compositeCoverage(twice, base, coverage, W, H, { x: 0, y: 60, width: W, height: 80 }, BLACK, false);
    compositeCoverage(twice, base, coverage, W, H, { x: 0, y: 60, width: W, height: 80 }, BLACK, false);
    expect(valueAt(twice, 150, 100)).toBe(valueAt(once, 150, 100));
  });

  it("erases by the same coverage rather than compositing colour", () => {
    const coverage = new Uint8ClampedArray(W * H);
    accumulateStrokeSegment(coverage, W, H, { x: 40, y: 100 }, { x: 150, y: 100 }, { x: 260, y: 100 }, 50, 1, 1, undefined, 0.82, 0.12, 1, 0, false, false, 0);
    const base = WHITE_BASE();
    const erased = WHITE_BASE();
    compositeCoverage(erased, base, coverage, W, H, { x: 0, y: 60, width: W, height: 80 }, BLACK, true);
    expect(erased[(100 * W + 150) * 4 + 3]!).toBeLessThan(6);
    // Outside the stroke the layer is untouched.
    expect(erased[(20 * W + 20) * 4 + 3]!).toBe(255);
  });
});
