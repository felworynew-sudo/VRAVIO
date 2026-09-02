import { describe, expect, it, vi } from "vitest";
import { InferenceCancelledError } from "@vravio/kernel";
import { imageToTensor, maskToRgba, resampleRgba, rgbaToMaskChannel, tensorToMask } from "./ml-tensor";
import { runTiledInference } from "./ml-inference";

const image = (width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const [r, g, b, a] = paint(x, y), index = (y * width + x) * 4;
    pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = a;
  }
  return pixels;
};

describe("image to tensor", () => {
  it("lays channels out planar for NCHW", () => {
    const pixels = image(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255]));

    const tensor = imageToTensor(pixels, 2, 1);

    expect([...tensor.dims]).toEqual([1, 3, 1, 2]);
    // All the reds, then all the greens, then all the blues.
    expect([...tensor.data]).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("lays channels out interleaved for NHWC", () => {
    const pixels = image(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255]));

    const tensor = imageToTensor(pixels, 2, 1, { layout: "nhwc" });

    expect([...tensor.dims]).toEqual([1, 1, 2, 3]);
    expect([...tensor.data]).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it("keeps alpha when asked for four channels", () => {
    const tensor = imageToTensor(image(1, 1, () => [0, 0, 0, 128]), 1, 1, { channels: 4 });

    expect([...tensor.dims]).toEqual([1, 4, 1, 1]);
    expect(tensor.data[3]).toBeCloseTo(128 / 255);
  });

  it("applies per-channel mean and standard deviation", () => {
    const tensor = imageToTensor(image(1, 1, () => [255, 128, 0, 255]), 1, 1, {
      mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225],
    });

    // Getting normalization wrong yields a plausible but quietly worse result,
    // so the arithmetic is pinned rather than eyeballed.
    expect(tensor.data[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(tensor.data[1]).toBeCloseTo((128 / 255 - 0.456) / 0.224, 5);
    expect(tensor.data[2]).toBeCloseTo((0 - 0.406) / 0.225, 5);
  });

  it("broadcasts a single mean and deviation across channels", () => {
    const tensor = imageToTensor(image(1, 1, () => [255, 255, 255, 255]), 1, 1, { mean: [0.5], std: [0.5] });

    expect([...tensor.data]).toEqual([1, 1, 1]);
  });

  it("refuses inputs that would silently produce nonsense", () => {
    expect(() => imageToTensor(new Uint8ClampedArray(3), 1, 1)).toThrow(/bytes of RGBA/);
    expect(() => imageToTensor(image(1, 1, () => [0, 0, 0, 255]), 1, 1, { std: [0.5, 0, 0.5] })).toThrow(/divide by zero/);
    expect(() => imageToTensor(image(1, 1, () => [0, 0, 0, 255]), 1, 1, { mean: [0.1, 0.2] })).toThrow(/Expected 3 values/);
  });
});

describe("tensor to mask", () => {
  const tensor = (values: number[], dims: number[]) => ({ data: Float32Array.from(values), dims });

  it("reads the shapes these models actually emit", () => {
    for (const dims of [[1, 1, 2, 2], [1, 2, 2], [2, 2]]) {
      expect([...tensorToMask(tensor([0, 0.5, 1, 0.25], dims), 2, 2)]).toEqual([0, 128, 255, 64]);
    }
  });

  it("clamps values outside the probability range", () => {
    expect([...tensorToMask(tensor([-2, 3], [1, 1, 1, 2]), 2, 1)]).toEqual([0, 255]);
  });

  it("stretches a mask that never reaches the ends of the range", () => {
    const stretched = tensorToMask(tensor([0.2, 0.4, 0.6, 0.8], [1, 1, 2, 2]), 2, 2, { normalize: true });

    // A subject the model was only 80% sure about should not come out
    // permanently translucent.
    expect(stretched[0]).toBe(0);
    expect(stretched[3]).toBe(255);
  });

  it("leaves a flat output alone rather than amplifying nothing", () => {
    expect([...tensorToMask(tensor([0.5, 0.5], [1, 1, 1, 2]), 2, 1, { normalize: true })]).toEqual([128, 128]);
  });

  it("picks a channel out of a multi-channel output", () => {
    const two = tensor([0, 0, 1, 1], [1, 2, 1, 2]);

    expect([...tensorToMask(two, 2, 1, { channel: 1 })]).toEqual([255, 255]);
    expect(() => tensorToMask(two, 2, 1, { channel: 5 })).toThrow(/asked for index 5/);
  });

  it("refuses a tensor too small for the image", () => {
    expect(() => tensorToMask(tensor([0, 1], [1, 1, 1, 2]), 4, 4)).toThrow(/need 16/);
  });

  it("round-trips a mask through RGBA for blending", () => {
    const mask = Uint8ClampedArray.from([0, 90, 200, 255]);

    expect([...rgbaToMaskChannel(maskToRgba(mask))]).toEqual([...mask]);
  });
});

describe("resampling", () => {
  it("returns a copy at the same size, not the original buffer", () => {
    const pixels = image(2, 2, () => [1, 2, 3, 4]);

    const result = resampleRgba(pixels, 2, 2, 2, 2);

    expect(result).not.toBe(pixels);
    expect([...result]).toEqual([...pixels]);
  });

  it("interpolates rather than picking the nearest pixel", () => {
    const pixels = image(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

    const wide = resampleRgba(pixels, 2, 1, 4, 1);

    // Nearest-neighbour would give 0,0,255,255 and put a staircase into every
    // mask edge. The middle samples have to land between the two.
    expect(wide[4]).toBeGreaterThan(0);
    expect(wide[4]).toBeLessThan(wide[8]!);
    expect(wide[8]).toBeLessThan(255);
  });

  it("keeps the corners of the image at the corners", () => {
    const pixels = image(4, 4, (x, y) => [x === 0 && y === 0 ? 255 : 0, 0, 0, 255]);

    const small = resampleRgba(pixels, 4, 4, 2, 2);

    expect(small[0]).toBeGreaterThan(0);
    expect(small[(2 * 2 - 1) * 4]).toBe(0);
  });

  it("refuses a target with no pixels", () => {
    expect(() => resampleRgba(image(2, 2, () => [0, 0, 0, 0]), 2, 2, 0, 2)).toThrow(/at least one pixel/);
  });
});

describe("tiled inference", () => {
  /** A model that returns a constant grey, so the seams are all that shows. */
  const constant = (value: number) => async (_tile: Uint8ClampedArray, size: number) => {
    const output = new Uint8ClampedArray(size * size * 4);
    output.fill(value);
    return output;
  };

  it("feeds the model its fixed input size whatever the image is", async () => {
    const sizes: number[] = [];
    await runTiledInference(image(70, 40, () => [0, 0, 0, 255]), 70, 40, async (tile, size) => {
      sizes.push(size);
      expect(tile.length).toBe(size * size * 4);
      return constant(255)(tile, size);
    }, { modelSize: 32, tileSize: 32, overlap: 8 });

    expect(sizes.length).toBeGreaterThan(1);
    expect(new Set(sizes)).toEqual(new Set([32]));
  });

  it("covers every pixel of the image", async () => {
    const result = await runTiledInference(image(100, 60, () => [0, 0, 0, 255]), 100, 60, constant(200), {
      modelSize: 32, tileSize: 32, overlap: 8,
    });

    expect(result.length).toBe(100 * 60 * 4);
    // A gap in the coverage shows up as a zero; a constant model must produce a
    // constant image right to the borders.
    expect([...result].every((value) => value === 200)).toBe(true);
  });

  it("blends the overlap instead of leaving a seam", async () => {
    // Each tile returns its own flat value, so tiles disagree everywhere they
    // meet. Without a cross-fade the joins would be step edges.
    let index = 0;
    const result = await runTiledInference(image(96, 32, () => [0, 0, 0, 255]), 96, 32, async (_tile, size) => {
      const value = index++ % 2 === 0 ? 40 : 200;
      const output = new Uint8ClampedArray(size * size * 4);
      output.fill(value);
      return output;
    }, { modelSize: 32, tileSize: 32, overlap: 16 });

    const row = (x: number) => result[(16 * 96 + x) * 4]!;
    let biggestStep = 0;
    for (let x = 1; x < 96; x += 1) biggestStep = Math.max(biggestStep, Math.abs(row(x) - row(x - 1)));
    expect(biggestStep).toBeLessThan(160);
  });

  it("runs one tile at a time", async () => {
    let inFlight = 0, peak = 0;
    await runTiledInference(image(96, 96, () => [0, 0, 0, 255]), 96, 96, async (tile, size) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return constant(10)(tile, size);
    }, { modelSize: 32, tileSize: 32, overlap: 8 });

    // Inference already saturates the accelerator; several at once buys nothing
    // and multiplies peak memory by the number in flight.
    expect(peak).toBe(1);
  });

  it("reports progress from zero to done", async () => {
    const seen: number[] = [];
    await runTiledInference(image(96, 32, () => [0, 0, 0, 255]), 96, 32, constant(10), {
      modelSize: 32, tileSize: 32, overlap: 8,
      onProgress: ({ ratio }) => seen.push(ratio),
    });

    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("stops when abandoned, without running the rest", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (tile: Uint8ClampedArray, size: number) => {
      controller.abort();
      return constant(10)(tile, size);
    });

    // A run on a large image takes a long time; a user who changed their mind
    // should not have to wait for the tiles that were still queued.
    await expect(runTiledInference(image(200, 200, () => [0, 0, 0, 255]), 200, 200, run, {
      modelSize: 32, tileSize: 32, overlap: 8, signal: controller.signal,
    })).rejects.toBeInstanceOf(InferenceCancelledError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses before doing any work when already abandoned", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(constant(10));

    await expect(runTiledInference(image(64, 64, () => [0, 0, 0, 255]), 64, 64, run, {
      modelSize: 32, signal: controller.signal,
    })).rejects.toBeInstanceOf(InferenceCancelledError);
    expect(run).not.toHaveBeenCalled();
  });

  it("says so when a model returns the wrong amount of data", async () => {
    await expect(runTiledInference(image(32, 32, () => [0, 0, 0, 255]), 32, 32, async () => new Uint8ClampedArray(10), {
      modelSize: 32,
    })).rejects.toThrow(/Model returned 10 bytes/);
  });

  it("refuses an image whose buffer does not match its size", async () => {
    await expect(runTiledInference(new Uint8ClampedArray(16), 32, 32, constant(10), { modelSize: 32 }))
      .rejects.toThrow(/bytes of RGBA/);
  });

  it("handles an image smaller than the model input", async () => {
    const result = await runTiledInference(image(10, 6, () => [0, 0, 0, 255]), 10, 6, constant(77), { modelSize: 32 });

    expect(result.length).toBe(10 * 6 * 4);
    expect([...result].every((value) => value === 77)).toBe(true);
  });
});
