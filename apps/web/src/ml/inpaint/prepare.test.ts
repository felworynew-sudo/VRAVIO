import { describe, expect, it } from "vitest";
import { buildInpaintInput, compositeInpaint, cropMask, cropRgba, readInpaintOutput, regionForMask, resampleMask } from "./prepare";
import { inpaintModelById, inpaintModels } from "./registry";
import type { InpaintModelDefinition } from "./types";

/**
 * Stage 10 of docs/migration-plan.md, the `ml/` half.
 *
 * Every check here is about a failure that does not throw. An inverted mask,
 * a value range off by a factor, a result pasted over the whole layer — all of
 * them produce a picture, just the wrong one, and no stack trace says so.
 * These are the parts that can be pinned down without a 200 MB model file, so
 * they are.
 */

const model = (id: string): InpaintModelDefinition => {
  const found = inpaintModelById(id);
  if (!found) throw new Error(`No model ${id}`);
  return found;
};

/** A square of solid colour, at a model's own size. */
const square = (size: number, r: number, g: number, b: number, a = 255) => {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < pixels.length; index += 4) { pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = a; }
  return pixels;
};

const maskWithFirstPixelMarked = (size: number) => {
  const mask = new Uint8ClampedArray(size * size);
  mask[0] = 255;
  return mask;
};

describe("the model catalogue", () => {
  it("found the definition files", () => {
    expect(inpaintModels.length).toBeGreaterThan(0);
  });

  it("gives every model its own id", () => {
    expect(new Set(inpaintModels.map((entry) => entry.id)).size).toBe(inpaintModels.length);
  });

  it("offers the cheapest model first", () => {
    // The brush defaults to the first, and defaulting to a 208 MB download
    // would be a surprising thing to do to someone who just picked up a brush.
    const sizes = inpaintModels.map((entry) => entry.spec.sizeBytes);
    expect([...sizes]).toEqual([...sizes].sort((a, b) => a - b));
  });

  it("keeps the two models' mask polarities opposite, as their exports are", () => {
    // Not a tidiness check: this is the one difference between them that fails
    // silently. With it wrong, the model faithfully repaints everything the
    // user did *not* mark and leaves the watermark alone.
    expect(model("lama").input.maskMeans).toBe("one-is-fill");
    expect(model("mi-gan-512").input.maskMeans).toBe("one-is-keep");
  });
});

describe("packing the input MI-GAN wants", () => {
  const migan = model("mi-gan-512");
  const size = migan.size;

  it("puts the mask in channel zero, biased", () => {
    const input = buildInpaintInput(square(size, 255, 0, 0), maskWithFirstPixelMarked(size), migan);
    const tensor = input[migan.input.kind === "packed-mask-first" ? migan.input.name : ""]!;

    // Marked means "do not keep" for this model, so 0, and the bias takes it
    // to -0.5. An unmarked pixel is 1 - 0.5 = 0.5.
    expect(tensor.data[0]).toBeCloseTo(-0.5);
    expect(tensor.data[1]).toBeCloseTo(0.5);
    expect(tensor.dims).toEqual([1, 4, size, size]);
  });

  it("zeroes the colour under the mark, and scales the rest to -1..1", () => {
    const input = buildInpaintInput(square(size, 255, 0, 0), maskWithFirstPixelMarked(size), migan);
    const data = Object.values(input)[0]!.data;
    const pixels = size * size;

    // Red channel is channel 1 of the packed tensor.
    expect(data[pixels + 0], "the hole was not zeroed").toBe(0);
    // 255 scaled to -1..1 is 1, kept because that pixel is not marked.
    expect(data[pixels + 1]).toBeCloseTo(1);
  });
});

describe("packing the two tensors LaMa wants", () => {
  const lama = model("lama");
  const size = lama.size;

  it("sends image and mask separately, image in 0..1", () => {
    const input = buildInpaintInput(square(size, 255, 128, 0), maskWithFirstPixelMarked(size), lama);

    expect(Object.keys(input).sort()).toEqual(["image", "mask"]);
    expect(input.image!.dims).toEqual([1, 3, size, size]);
    expect(input.mask!.dims).toEqual([1, 1, size, size]);
    expect(input.image!.data[0]).toBeCloseTo(1);
  });

  it("marks the hole with one, the opposite of MI-GAN", () => {
    const input = buildInpaintInput(square(size, 10, 10, 10), maskWithFirstPixelMarked(size), lama);

    expect(input.mask!.data[0], "LaMa was told to keep the marked pixel").toBe(1);
    expect(input.mask!.data[1]).toBe(0);
  });

  it("does not premultiply, because LaMa is not asking for that", () => {
    const input = buildInpaintInput(square(size, 255, 255, 255), maskWithFirstPixelMarked(size), lama);

    // The marked pixel keeps its colour in the image tensor; the mask is what
    // tells LaMa to ignore it.
    expect(input.image!.data[0]).toBeCloseTo(1);
  });
});

describe("reading a model's answer", () => {
  const lama = model("lama");
  const size = lama.size;

  it("takes a 0..255 output as it stands", () => {
    const data = new Float32Array(size * size * 3).fill(200);
    const out = readInpaintOutput({ data, dims: [1, 3, size, size] }, lama, square(size, 0, 0, 0));

    expect(out[0]).toBe(200);
  });

  it("maps a -1..1 output through (v/2 + 1/2) * 255", () => {
    const migan = model("mi-gan-512");
    const data = new Float32Array(migan.size * migan.size * 3).fill(0);
    const out = readInpaintOutput({ data, dims: [1, 3, migan.size, migan.size] }, migan, square(migan.size, 0, 0, 0));

    // Zero is the middle of -1..1, so mid-grey — not black, which is what
    // treating it as 0..255 would give.
    expect(out[0]).toBe(128);
  });

  it("carries alpha over instead of inventing it", () => {
    // These models were trained on opaque photographs and return no alpha at
    // all; making one up would turn transparent pixels solid.
    const data = new Float32Array(size * size * 3).fill(255);
    const source = square(size, 0, 0, 0, 0);
    const out = readInpaintOutput({ data, dims: [1, 3, size, size] }, lama, source);

    expect(out[3]).toBe(0);
  });

  it("refuses an output that is too small rather than reading past it", () => {
    expect(() => readInpaintOutput({ data: new Float32Array(12), dims: [1, 3, 2, 2] }, lama, square(size, 0, 0, 0)))
      .toThrow(/expected at least/);
  });
});

describe("choosing the region to run on", () => {
  it("returns nothing when nothing is marked", () => {
    expect(regionForMask(new Uint8ClampedArray(64 * 64), 64, 64)).toBeNull();
  });

  it("is square, because the model's input is", () => {
    // A non-square crop would be squashed into the square input and the model
    // would inpaint a distorted picture.
    const mask = new Uint8ClampedArray(64 * 64);
    for (let x = 10; x < 50; x += 1) mask[20 * 64 + x] = 255;

    const region = regionForMask(mask, 64, 64)!;

    expect(region.width).toBe(region.height);
  });

  it("takes more than the mark, so the model has something to continue from", () => {
    const mask = new Uint8ClampedArray(128 * 128);
    for (let y = 60; y < 68; y += 1) for (let x = 60; x < 68; x += 1) mask[y * 128 + x] = 255;

    const region = regionForMask(mask, 128, 128)!;

    // A hole with no surroundings has nothing to infer from.
    expect(region.width).toBeGreaterThan(8);
  });

  it("stays inside the picture", () => {
    const mask = new Uint8ClampedArray(64 * 64);
    mask[0] = 255;

    const region = regionForMask(mask, 64, 64)!;

    expect(region.x).toBeGreaterThanOrEqual(0);
    expect(region.y).toBeGreaterThanOrEqual(0);
    expect(region.x + region.width).toBeLessThanOrEqual(64);
    expect(region.y + region.height).toBeLessThanOrEqual(64);
  });
});

describe("putting the answer back", () => {
  const W = 8, H = 8;
  const region = { x: 2, y: 2, width: 4, height: 4 };

  it("changes the marked pixels and leaves every other one alone", () => {
    // The check that matters most. These models return a whole new picture,
    // every pixel a little different; writing all of it back would resample
    // the untouched part of the layer through two scalings for no reason.
    const original = square(W, 10, 20, 30);
    const filled = square(region.width, 200, 200, 200);
    const mask = new Uint8ClampedArray(W * H);
    mask[3 * W + 3] = 255;

    const out = compositeInpaint(original, W, H, filled, mask, region);

    expect(out[(3 * W + 3) * 4]).toBe(200);
    expect(out[(0 * W + 0) * 4], "a pixel outside the mark was changed").toBe(10);
    expect(out[(2 * W + 2) * 4], "a pixel inside the region but outside the mark was changed").toBe(10);
  });

  it("blends by the mask's own value, so a soft edge does not leave a hard one", () => {
    const original = square(W, 0, 0, 0);
    const filled = square(region.width, 100, 100, 100);
    const mask = new Uint8ClampedArray(W * H);
    mask[3 * W + 3] = 128;

    const out = compositeInpaint(original, W, H, filled, mask, region);

    expect(out[(3 * W + 3) * 4]).toBeCloseTo(50, -1);
  });

  it("makes the filled area transparent when its surroundings are", () => {
    // Found on the deployed site: a black stroke on an empty layer gave the
    // model a black surround, so it filled the hole with black — and with the
    // alpha carried over unchanged the stroke stayed exactly as visible as
    // before. The brush appeared to do nothing at all. Alpha has to follow the
    // surroundings, because the models cannot see it.
    const original = square(W, 0, 0, 0, 0);
    const at = (3 * W + 3) * 4;
    original[at + 3] = 255; // the stroke: one opaque pixel on an empty layer
    const filled = square(region.width, 0, 0, 0);
    const mask = new Uint8ClampedArray(W * H);
    mask[3 * W + 3] = 255;

    const out = compositeInpaint(original, W, H, filled, mask, region);

    expect(out[at + 3], "the marked pixel stayed opaque on an empty layer").toBe(0);
  });

  it("keeps the filled area opaque when its surroundings are", () => {
    // The other half of the same rule, and the case the models were trained
    // for: on a photograph every neighbour is opaque and nothing should change.
    const original = square(W, 10, 20, 30, 255);
    const filled = square(region.width, 200, 200, 200);
    const mask = new Uint8ClampedArray(W * H);
    mask[3 * W + 3] = 255;

    expect(compositeInpaint(original, W, H, filled, mask, region)[(3 * W + 3) * 4 + 3]).toBe(255);
  });

  it("leaves alpha alone when the mark covers everything, having nothing to go on", () => {
    const original = square(W, 10, 10, 10, 200);
    const filled = square(region.width, 50, 50, 50);
    const mask = new Uint8ClampedArray(W * H).fill(255);

    expect(compositeInpaint(original, W, H, filled, mask, region)[(3 * W + 3) * 4 + 3]).toBe(200);
  });

  it("leaves alpha as it was", () => {
    // Uniform alpha everywhere, so the surroundings say "77" and nothing moves.
    const original = square(W, 10, 10, 10, 77);
    const filled = square(region.width, 200, 200, 200, 255);
    const mask = new Uint8ClampedArray(W * H);
    mask[3 * W + 3] = 255;

    expect(compositeInpaint(original, W, H, filled, mask, region)[(3 * W + 3) * 4 + 3]).toBe(77);
  });
});

describe("cutting the region out", () => {
  it("copies the right pixels", () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    for (let index = 0; index < 16; index += 1) pixels[index * 4] = index;

    expect(cropRgba(pixels, 4, { x: 1, y: 1, width: 2, height: 2 })[0]).toBe(5);
  });

  it("cuts the mask the same way", () => {
    const mask = new Uint8ClampedArray(16);
    for (let index = 0; index < 16; index += 1) mask[index] = index;

    expect([...cropMask(mask, 4, { x: 1, y: 1, width: 2, height: 2 })]).toEqual([5, 6, 9, 10]);
  });

  it("keeps a resampled mask to hard yes or no", () => {
    // A mask is a decision, not a picture: a smoothed edge would ask the model
    // to half-fill a pixel, which it has no way to express.
    const mask = new Uint8ClampedArray(4 * 4);
    mask[0] = 255;

    const resampled = resampleMask(mask, 4, 4, 8);

    expect([...new Set(resampled)].sort()).toEqual([0, 255]);
  });
});
