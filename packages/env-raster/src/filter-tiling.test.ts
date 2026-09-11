import { describe, expect, it } from "vitest";
import { applyRasterFilter } from "./filters";
import { PARALLEL_SAFE_FILTERS, paddingForFilter, planFilterBands, type FilterBand } from "./filter-tiling";

describe("paddingForFilter", () => {
  it("mirrors blur()'s own radius clamp for radius-driven filters", () => {
    expect(paddingForFilter("gaussian_blur", { radius: 5 })).toBe(5);
    expect(paddingForFilter("gaussian_blur", { radius: 0 })).toBe(1);
    expect(paddingForFilter("gaussian_blur", { radius: 999 })).toBe(32);
    expect(paddingForFilter("gaussian_blur", {})).toBe(2);
  });

  it("uses filters.ts's own fixed internal radius for the sharpen family, ignoring any radius setting", () => {
    expect(paddingForFilter("sharpen", { radius: 20 })).toBe(2);
    expect(paddingForFilter("high_pass", {})).toBe(2);
  });

  it("uses a one-pixel margin for the single-neighbour stylise filters", () => {
    expect(paddingForFilter("edge_detect", {})).toBe(1);
    expect(paddingForFilter("emboss", { radius: 40 })).toBe(1);
  });
});

describe("planFilterBands", () => {
  it("splits evenly and covers every row exactly once", () => {
    const bands = planFilterBands(100, 2, 4);
    expect(bands).toHaveLength(4);
    expect(bands[0]!.startY).toBe(0);
    expect(bands.at(-1)!.endY).toBe(100);
    for (let index = 1; index < bands.length; index += 1) expect(bands[index]!.startY).toBe(bands[index - 1]!.endY);
  });

  it("refuses to cut a band thinner than its own padding needs", () => {
    // 20 rows, padding 15 -> a band needs at least 30 rows of margin alone; splitting at all
    // would spend more work on padding than on the rows it keeps.
    expect(planFilterBands(20, 15, 8)).toEqual<FilterBand[]>([{ startY: 0, endY: 20 }]);
  });

  it("never exceeds maxBands even on a huge image", () => {
    expect(planFilterBands(100000, 2, 3)).toHaveLength(3);
  });

  it("falls back to one band when maxBands is 1", () => {
    expect(planFilterBands(1000, 2, 1)).toEqual<FilterBand[]>([{ startY: 0, endY: 1000 }]);
  });
});

describe("PARALLEL_SAFE_FILTERS, checked against the real filter output", () => {
  const w = 40, h = 37; // odd height on purpose: exercises the uneven last band.

  function fixture(): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 31 + 7) % 256;
    return pixels;
  }

  /** What `filter-worker-pool.ts`'s `applyRasterFilterParallel` does, reimplemented in-process
   *  against the real `applyRasterFilter` (no Worker) so this test proves the *planning* module
   *  actually produces a byte-identical result, not just that it type-checks. The Worker
   *  plumbing around it is tested separately in apps/web/src against a fake worker, the same
   *  split `heal-membrane-pool.test.ts` already uses for the reason given there — a real Worker
   *  is unavailable here and would test the platform, not this file's own band/padding maths. */
  function runBandedInProcess(source: Uint8ClampedArray, id: string, settings: Record<string, number>, maxBands: number): Uint8ClampedArray {
    const padding = paddingForFilter(id, settings);
    const bands = planFilterBands(h, padding, maxBands);
    const output = new Uint8ClampedArray(source.length);
    for (const band of bands) {
      const sliceStart = Math.max(0, band.startY - padding);
      const sliceEnd = Math.min(h, band.endY + padding);
      const sliceHeight = sliceEnd - sliceStart;
      const slice = source.subarray(sliceStart * w * 4, sliceEnd * w * 4);
      const rendered = applyRasterFilter(slice, w, sliceHeight, id, settings);
      const bandOffsetInSlice = band.startY - sliceStart;
      const bandHeight = band.endY - band.startY;
      output.set(rendered.subarray(bandOffsetInSlice * w * 4, (bandOffsetInSlice + bandHeight) * w * 4), band.startY * w * 4);
    }
    return output;
  }

  for (const id of PARALLEL_SAFE_FILTERS) {
    it(`${id}: banded (4 bands) output matches the single-region result byte-for-byte`, () => {
      const source = fixture();
      const settings = { radius: 6, amount: 100 };
      const whole = applyRasterFilter(source, w, h, id, settings);
      const banded = runBandedInProcess(source, id, settings, 4);
      expect([...banded]).toEqual([...whole]);
    });
  }

  it("a large radius on a small image still matches once bands collapse to one", () => {
    const source = fixture();
    const settings = { radius: 30 };
    const whole = applyRasterFilter(source, w, h, "gaussian_blur", settings);
    const banded = runBandedInProcess(source, "gaussian_blur", settings, 8);
    expect([...banded]).toEqual([...whole]);
  });
});
