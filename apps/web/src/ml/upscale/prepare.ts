/**
 * The tiling math for a fully-convolutional upscaler on an image bigger than
 * one tile.
 *
 * Pure and tested without a model, for the same reason `ml/inpaint/prepare.ts`
 * is: an off-by-one here does not throw, it draws a seam or repeats a strip
 * of pixels, and nobody notices until they zoom into the result.
 *
 * The algorithm is `xinntao/Real-ESRGAN`'s own `RealESRGANer.tile_process`
 * (`realesrgan/utils.py`): grow each tile by `overlap` pixels of surrounding
 * context on every side it has room for, run the model on that padded tile,
 * then keep only the part of the answer that corresponds to the tile's own
 * (unpadded) footprint — scaled up. Tiles placed this way already agree at
 * their borders because each one saw real neighbouring pixels while
 * computing them, so there is nothing left to blend.
 */

export interface TileSpec {
  readonly size: number;
  readonly overlap: number;
}

export interface TilePlan {
  /** The tile's own footprint in the source image — where its output lands. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The region actually cropped and fed to the model — the footprint above,
   * grown by `overlap` and clamped to the image. */
  readonly padX: number;
  readonly padY: number;
  readonly padWidth: number;
  readonly padHeight: number;
}

/** Splits `width`×`height` into a grid of tiles, each carrying its own padded
 * crop region. Returns a single tile covering the whole image when it
 * already fits within one. */
export function planTiles(width: number, height: number, tile: TileSpec): readonly TilePlan[] {
  if (width <= tile.size && height <= tile.size) {
    return [{ x: 0, y: 0, width, height, padX: 0, padY: 0, padWidth: width, padHeight: height }];
  }
  const plans: TilePlan[] = [];
  for (let y = 0; y < height; y += tile.size) {
    const h = Math.min(tile.size, height - y);
    for (let x = 0; x < width; x += tile.size) {
      const w = Math.min(tile.size, width - x);
      const padX = Math.max(0, x - tile.overlap);
      const padY = Math.max(0, y - tile.overlap);
      const padRight = Math.min(width, x + w + tile.overlap);
      const padBottom = Math.min(height, y + h + tile.overlap);
      plans.push({ x, y, width: w, height: h, padX, padY, padWidth: padRight - padX, padHeight: padBottom - padY });
    }
  }
  return plans;
}

/** Cuts a rectangle out of an RGBA buffer. */
export function cropRgba(pixels: Uint8ClampedArray, width: number, region: { x: number; y: number; width: number; height: number }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(region.width * region.height * 4);
  for (let y = 0; y < region.height; y += 1) {
    const from = ((region.y + y) * width + region.x) * 4;
    out.set(pixels.subarray(from, from + region.width * 4), y * region.width * 4);
  }
  return out;
}

/**
 * Places a tile's (already upscaled) output into the full output image,
 * keeping only the part that corresponds to the tile's own unpadded
 * footprint — the crop step `planTiles`'s own doc comment describes.
 */
export function placeTileOutput(
  output: Uint8ClampedArray, outputWidth: number, outputHeight: number,
  tileOutput: Uint8ClampedArray, plan: TilePlan, scale: number,
): void {
  const offsetX = (plan.x - plan.padX) * scale, offsetY = (plan.y - plan.padY) * scale;
  const tileOutputWidth = plan.padWidth * scale;
  const targetWidth = plan.width * scale, targetHeight = plan.height * scale;
  for (let y = 0; y < targetHeight; y += 1) {
    const targetY = plan.y * scale + y;
    if (targetY >= outputHeight) continue;
    const from = ((offsetY + y) * tileOutputWidth + offsetX) * 4;
    const to = (targetY * outputWidth + plan.x * scale) * 4;
    output.set(tileOutput.subarray(from, from + targetWidth * 4), to);
  }
}

/**
 * Tiles blended over their overlap instead of butted together.
 *
 * `placeTileOutput` keeps exactly the tile's own footprint, on Real-ESRGAN's own reasoning: each
 * tile saw `overlap` pixels of real context, so its edges already agree with its neighbour's.
 * That holds while the context is wide relative to what the network actually looks at — and the
 * denoiser (RealPLKSR, partial *large* kernel) looks much further than its 16-pixel margin, so
 * the two sides of a tile boundary can answer differently and the join shows as a grid on flat,
 * noisy areas (owner: AI Denoise "works strangely", docs/master-plan.md §58.1).
 *
 * The fix is the standard one (the same weighted-overlap scheme darktable and Krita use when they
 * process an image in pieces): every tile contributes its whole padded output, weighted 1 inside
 * its own footprint and ramping to 0 across the context margin, and the sums are normalised at the
 * end. Where only one tile contributes the result is exactly that tile; where two do, the
 * transition is gradual and no edge can appear.
 */
export interface TileAccumulator {
  readonly width: number;
  readonly height: number;
  readonly colour: Float32Array;
  readonly weight: Float32Array;
}

export function createTileAccumulator(width: number, height: number): TileAccumulator {
  return { width, height, colour: new Float32Array(width * height * 4), weight: new Float32Array(width * height) };
}

export function accumulateTileOutput(accumulator: TileAccumulator, tileOutput: Uint8ClampedArray, plan: TilePlan, scale: number): void {
  const padWidth = plan.padWidth * scale, padHeight = plan.padHeight * scale;
  const left = plan.padX * scale, top = plan.padY * scale;
  // Ramp widths: the context margin on each side, which is zero where the tile sits against the
  // image edge (nothing to blend with there, and the tile's own answer is the only one).
  const rampLeft = (plan.x - plan.padX) * scale, rampTop = (plan.y - plan.padY) * scale;
  const rampRight = (plan.padX + plan.padWidth - plan.x - plan.width) * scale;
  const rampBottom = (plan.padY + plan.padHeight - plan.y - plan.height) * scale;
  const ramp = (position: number, size: number, before: number, after: number): number => {
    let weight = 1;
    if (before > 0 && position < before) weight = Math.min(weight, (position + 0.5) / before);
    const fromEnd = size - 1 - position;
    if (after > 0 && fromEnd < after) weight = Math.min(weight, (fromEnd + 0.5) / after);
    return weight;
  };
  for (let y = 0; y < padHeight; y += 1) {
    const targetY = top + y;
    if (targetY < 0 || targetY >= accumulator.height) continue;
    const weightY = ramp(y, padHeight, rampTop, rampBottom);
    for (let x = 0; x < padWidth; x += 1) {
      const targetX = left + x;
      if (targetX < 0 || targetX >= accumulator.width) continue;
      const weight = weightY * ramp(x, padWidth, rampLeft, rampRight);
      if (weight <= 0) continue;
      const from = (y * padWidth + x) * 4, to = (targetY * accumulator.width + targetX) * 4;
      accumulator.colour[to] = accumulator.colour[to]! + tileOutput[from]! * weight;
      accumulator.colour[to + 1] = accumulator.colour[to + 1]! + tileOutput[from + 1]! * weight;
      accumulator.colour[to + 2] = accumulator.colour[to + 2]! + tileOutput[from + 2]! * weight;
      accumulator.colour[to + 3] = accumulator.colour[to + 3]! + tileOutput[from + 3]! * weight;
      const weightAt = targetY * accumulator.width + targetX;
      accumulator.weight[weightAt] = accumulator.weight[weightAt]! + weight;
    }
  }
}

export function finishTileAccumulator(accumulator: TileAccumulator): Uint8ClampedArray {
  const output = new Uint8ClampedArray(accumulator.width * accumulator.height * 4);
  for (let pixel = 0; pixel < accumulator.weight.length; pixel += 1) {
    const weight = accumulator.weight[pixel]!;
    if (weight <= 0) continue;
    const at = pixel * 4;
    output[at] = accumulator.colour[at]! / weight;
    output[at + 1] = accumulator.colour[at + 1]! / weight;
    output[at + 2] = accumulator.colour[at + 2]! / weight;
    output[at + 3] = accumulator.colour[at + 3]! / weight;
  }
  return output;
}
