import { describe, expect, it } from "vitest";
import { cropRgba, placeTileOutput, planTiles } from "./prepare";
import { upscaleModelById, upscaleModels } from "./registry";

/**
 * The tiling math, checked without a model file — same reasoning as
 * `ml/inpaint/prepare.test.ts`: an off-by-one here draws a seam or repeats a
 * strip of pixels, and nothing throws to say so.
 */

describe("the model catalogue", () => {
  it("found the definition files", () => {
    expect(upscaleModels.length).toBeGreaterThan(0);
  });

  it("gives every model its own id", () => {
    const ids = upscaleModels.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds a model by id", () => {
    const model = upscaleModelById("real-esrgan-general-x4v3");
    expect(model?.scale).toBe(4);
  });
});

describe("planTiles", () => {
  it("gives one full-image tile when the image already fits", () => {
    const plans = planTiles(200, 150, { size: 256, overlap: 16 });
    expect(plans).toEqual([{ x: 0, y: 0, width: 200, height: 150, padX: 0, padY: 0, padWidth: 200, padHeight: 150 }]);
  });

  it("covers the whole image with no gaps and no overlap between footprints", () => {
    const width = 600, height = 400;
    const plans = planTiles(width, height, { size: 256, overlap: 16 });
    const covered = new Uint8Array(width * height);
    for (const plan of plans) {
      for (let y = 0; y < plan.height; y += 1) {
        for (let x = 0; x < plan.width; x += 1) {
          const index = (plan.y + y) * width + (plan.x + x);
          expect(covered[index]).toBe(0); // no footprint overlaps another
          covered[index] = 1;
        }
      }
    }
    expect(covered.every((value) => value === 1)).toBe(true); // and nothing is left uncovered
  });

  it("pads a tile with context, clamped to the image", () => {
    const plans = planTiles(800, 800, { size: 256, overlap: 16 });
    const topLeft = plans[0]!;
    // At the image's own top-left corner, there is no context to grow into.
    expect(topLeft).toEqual({ x: 0, y: 0, width: 256, height: 256, padX: 0, padY: 0, padWidth: 272, padHeight: 272 });

    // A tile away from every edge (800 is more than 256*2+256, so the tile at
    // (256,256) has a full 256x256 neighbour on every side) grows by the full
    // overlap on all four sides.
    const interior = plans.find((plan) => plan.x === 256 && plan.y === 256)!;
    expect(interior.width).toBe(256);
    expect(interior.height).toBe(256);
    expect(interior.padX).toBe(256 - 16);
    expect(interior.padY).toBe(256 - 16);
    expect(interior.padWidth).toBe(interior.width + 16 * 2);
    expect(interior.padHeight).toBe(interior.height + 16 * 2);
  });

  it("only grows into the room it actually has at an image edge", () => {
    // 400 tall with 256-tall tiles leaves a 144-tall bottom row with no room
    // to grow downward — a tile touching the bottom edge should still clamp
    // there rather than reading past the image.
    const plans = planTiles(600, 400, { size: 256, overlap: 16 });
    const bottomRow = plans.find((plan) => plan.x === 256 && plan.y === 256)!;
    expect(bottomRow.height).toBe(144); // 400 - 256
    expect(bottomRow.padY).toBe(256 - 16);
    expect(bottomRow.padHeight).toBe(400 - (256 - 16)); // clamped at the image's own bottom edge
  });

  it("never asks for a pad region reaching past the image", () => {
    const width = 600, height = 400;
    for (const plan of planTiles(width, height, { size: 256, overlap: 16 })) {
      expect(plan.padX).toBeGreaterThanOrEqual(0);
      expect(plan.padY).toBeGreaterThanOrEqual(0);
      expect(plan.padX + plan.padWidth).toBeLessThanOrEqual(width);
      expect(plan.padY + plan.padHeight).toBeLessThanOrEqual(height);
    }
  });
});

describe("cropRgba", () => {
  it("cuts the requested rectangle out, row by row", () => {
    const width = 4, height = 4;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) pixels[index * 4] = index; // red channel = flat index
    const cropped = cropRgba(pixels, width, { x: 1, y: 1, width: 2, height: 2 });
    expect([cropped[0], cropped[4], cropped[8], cropped[12]]).toEqual([5, 6, 9, 10]);
  });
});

describe("placeTileOutput", () => {
  const scale = 2;

  it("keeps only a padded tile's own footprint, discarding the context border", () => {
    // A single interior tile: footprint 4x4 at (4,4), padded by 2 on every side to 8x8.
    const plan = { x: 4, y: 4, width: 4, height: 4, padX: 2, padY: 2, padWidth: 8, padHeight: 8 };
    const outputWidth = 20, outputHeight = 20;
    const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
    // The tile's upscaled output is 16x16; fill it with its own flat index so the
    // kept region can be checked exactly against what should have been copied.
    const tileOutputSize = plan.padWidth * scale;
    const tileOutput = new Uint8ClampedArray(tileOutputSize * tileOutputSize * 4);
    for (let index = 0; index < tileOutputSize * tileOutputSize; index += 1) tileOutput[index * 4] = index % 256;

    placeTileOutput(output, outputWidth, outputHeight, tileOutput, plan, scale);

    // The footprint's own top-left corner in the *tile's own* upscaled output is
    // offset by (x - padX, y - padY) * scale = (2, 2) * 2 = (4, 4).
    const expectedFirstValue = (4 * tileOutputSize + 4) % 256;
    const placedAt = (plan.y * scale * outputWidth + plan.x * scale) * 4;
    expect(output[placedAt]).toBe(expectedFirstValue);

    // Nothing outside the footprint's target rectangle was touched.
    expect(output[0]).toBe(0);
    expect(output[(outputWidth * outputHeight - 1) * 4]).toBe(0);
  });

  it("places adjacent tiles' footprints with no gap and no overlap", () => {
    const width = 8, height = 4, tileSpec = { size: 4, overlap: 1 };
    const plans = planTiles(width, height, tileSpec);
    const outputWidth = width * scale, outputHeight = height * scale;
    const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
    const touched = new Uint8Array(outputWidth * outputHeight);

    for (const plan of plans) {
      const tileOutputSize1 = plan.padWidth * scale, tileOutputSize2 = plan.padHeight * scale;
      const tileOutput = new Uint8ClampedArray(tileOutputSize1 * tileOutputSize2 * 4).fill(255);
      placeTileOutput(output, outputWidth, outputHeight, tileOutput, plan, scale);
      for (let y = 0; y < plan.height * scale; y += 1) {
        for (let x = 0; x < plan.width * scale; x += 1) {
          const index = (plan.y * scale + y) * outputWidth + (plan.x * scale + x);
          expect(touched[index]).toBe(0);
          touched[index] = 1;
        }
      }
    }
    expect(touched.every((value) => value === 1)).toBe(true);
  });
});
