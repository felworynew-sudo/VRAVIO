import { describe, expect, it } from "vitest";
import { applyRasterFilter, rasterFilterCatalog } from "./index";

/**
 * The owner's report: the noise filters do not work correctly.
 *
 * What they were doing was one step of an LCG over the *byte index*
 * (`(imul(i + 1, 1103515245) + 12345) >>> 16 & 255`). Over indices that step by
 * exactly 4 the bits that shift out cycle, so the "noise" was a repeating
 * pattern rather than grain, identical on every row — and Add Noise and Analog
 * Grain ran the same three lines, so the two catalogue entries were the same
 * filter under two names.
 *
 * These check the properties that tell noise from a pattern, rather than
 * pinning exact bytes: the port is of Patchy's `render_add_noise_effect`
 * (smart_filter_renderer.cpp), and a byte-level snapshot would only be a record
 * of what this code does, not of what makes it correct.
 */

const WIDTH = 64, HEIGHT = 64;

/** Flat mid-grey: on a uniform field, everything that varies is the filter. */
function flatField(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    pixels[index * 4] = 128; pixels[index * 4 + 1] = 128; pixels[index * 4 + 2] = 128; pixels[index * 4 + 3] = 255;
  }
  return pixels;
}


describe("noise filters", () => {
  it("gives Add Noise and Analog Grain their own amount, defaulting the way Photoshop does", () => {
    for (const id of ["add_noise", "film_grain"]) {
      const definition = rasterFilterCatalog.find((entry) => entry.id === id)!;
      const amount = definition.parameters.find((parameter) => parameter.id === "amount")!;
      // Photoshop's Add Noise opens at 12.5%, not at a full-strength wash; the
      // shared 0-100 "amount" slider defaulted to 100, which on this filter is
      // a ±255 range — every pixel replaced by static.
      expect(amount.value).toBe(12);
    }
  });

  it("has no regular step between neighbouring pixels", () => {
    // The property that actually separates noise from the pattern this
    // replaced. The old index-LCG changed by the same amount from one pixel to
    // the next almost everywhere — measured, its whole 64x64 field used only
    // FOUR distinct horizontal steps, a repeating +25 ramp that wrapped, which
    // renders as fine diagonal stripes rather than grain. (Row-to-row variety,
    // the first thing worth checking, turned out not to discriminate at all:
    // the old version produced 64 distinct rows too.)
    const output = applyRasterFilter(flatField(), WIDTH, HEIGHT, "add_noise", { amount: 20 });
    const steps = new Set<number>();
    for (let y = 0; y < HEIGHT; y += 1) for (let x = 1; x < WIDTH; x += 1) {
      steps.add(output[(y * WIDTH + x) * 4]! - output[(y * WIDTH + x - 1) * 4]!);
    }
    expect(steps.size).toBeGreaterThan(60);
  });

  it("spreads values around the original instead of leaning to one side", () => {
    const output = applyRasterFilter(flatField(), WIDTH, HEIGHT, "add_noise", { amount: 20 });
    let sum = 0, below = 0, above = 0, distinct = new Set<number>();
    for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
      const red = output[index * 4]!;
      sum += red - 128; distinct.add(red);
      if (red < 128) below += 1;
      if (red > 128) above += 1;
    }
    // Centred on the source value: the mean shift is a rounding error, not a
    // brightness change, and both directions are represented.
    expect(Math.abs(sum / (WIDTH * HEIGHT))).toBeLessThan(1);
    expect(below).toBeGreaterThan(WIDTH * HEIGHT * 0.4);
    expect(above).toBeGreaterThan(WIDTH * HEIGHT * 0.4);
    // A range of ±51 at 20%, so the values reached should be many, not a few.
    expect(distinct.size).toBeGreaterThan(50);
  });

  it("makes Add Noise coloured and Analog Grain monochromatic", () => {
    const noise = applyRasterFilter(flatField(), WIDTH, HEIGHT, "add_noise", { amount: 20 });
    const grain = applyRasterFilter(flatField(), WIDTH, HEIGHT, "film_grain", { amount: 20 });

    let colouredPixels = 0, greyPixels = 0;
    for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
      const at = index * 4;
      if (noise[at] !== noise[at + 1] || noise[at + 1] !== noise[at + 2]) colouredPixels += 1;
      if (grain[at] === grain[at + 1] && grain[at + 1] === grain[at + 2]) greyPixels += 1;
    }
    // Add Noise gives each channel its own hash lane — Photoshop's default,
    // which reads as colour speckle. Analog Grain shares one lane across all
    // three, which is what grain actually looks like.
    expect(colouredPixels).toBeGreaterThan(WIDTH * HEIGHT * 0.9);
    expect(greyPixels).toBe(WIDTH * HEIGHT);
    // And therefore the two filters are not the same filter twice.
    expect(Array.from(noise)).not.toEqual(Array.from(grain));
  });

  it("scales with the amount and leaves alpha alone", () => {
    const gentle = applyRasterFilter(flatField(), WIDTH, HEIGHT, "add_noise", { amount: 5 });
    const strong = applyRasterFilter(flatField(), WIDTH, HEIGHT, "add_noise", { amount: 60 });
    const spread = (pixels: Uint8ClampedArray) => {
      let total = 0;
      for (let index = 0; index < WIDTH * HEIGHT; index += 1) total += Math.abs(pixels[index * 4]! - 128);
      return total / (WIDTH * HEIGHT);
    };
    expect(spread(strong)).toBeGreaterThan(spread(gentle) * 3);

    const source = flatField();
    for (let index = 0; index < WIDTH * HEIGHT; index += 1) expect(strong[index * 4 + 3]).toBe(source[index * 4 + 3]);
  });

  it("is deterministic, so the same image filtered twice matches", () => {
    const first = applyRasterFilter(flatField(), WIDTH, HEIGHT, "add_noise", { amount: 12 });
    const second = applyRasterFilter(flatField(), WIDTH, HEIGHT, "add_noise", { amount: 12 });
    expect(Array.from(first)).toEqual(Array.from(second));
  });
});
