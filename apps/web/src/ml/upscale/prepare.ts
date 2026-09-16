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
