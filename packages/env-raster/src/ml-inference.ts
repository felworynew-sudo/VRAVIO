import { InferenceCancelledError, throwIfAborted } from "@vravio/kernel";
import { TileCompositor, extractTile, planTiles } from "./tiling";
import { resampleRgba } from "./ml-tensor";

export interface TiledInferenceProgress {
  readonly completed: number;
  readonly total: number;
  /** 0..1. */
  readonly ratio: number;
}

export interface TiledInferenceOptions {
  /** The fixed input the model takes. Tiles are resized to it and back. */
  readonly modelSize: number;
  /** Skirt shared with each neighbour. 32-64 px is the usual range. */
  readonly overlap?: number;
  /**
   * Region of the image to work on. Everything outside is left as it was, which
   * is what makes "apply to the selection" possible.
   */
  readonly tileSize?: number;
  readonly signal?: AbortSignal;
  onProgress?(progress: TiledInferenceProgress): void;
}

/** Runs one tile through a model. RGBA in, RGBA out, both `modelSize` square. */
export type TileRunner = (tile: Uint8ClampedArray, size: number, signal?: AbortSignal) => Promise<Uint8ClampedArray>;

/**
 * Runs a model over an image too large to feed it in one go.
 *
 * A model takes a fixed input, so anything bigger is cut into overlapping tiles
 * and the results are cross-faded back together. Without the overlap the model
 * sees a hard edge at every cut and the seams are visible in the output; with
 * it, each pixel in a seam is a weighted blend of the tiles that saw context on
 * both sides.
 *
 * Tiles run one at a time on purpose. Inference already saturates the
 * accelerator, so issuing several at once buys nothing and multiplies peak
 * memory by the number in flight — which on a large image is how the tab dies.
 */
export async function runTiledInference(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  run: TileRunner,
  options: TiledInferenceOptions,
): Promise<Uint8ClampedArray> {
  const modelSize = Math.max(1, Math.floor(options.modelSize));
  const tileSize = Math.max(1, Math.floor(options.tileSize ?? modelSize));
  const overlap = Math.max(0, Math.min(Math.floor(options.overlap ?? Math.round(tileSize / 8)), tileSize - 1));
  if (pixels.length !== width * height * 4) throw new RangeError(`Expected ${width * height * 4} bytes of RGBA, got ${pixels.length}`);
  throwIfAborted(options.signal);

  const plans = planTiles(width, height, { tileSize, overlap });
  const compositor = new TileCompositor(width, height);
  let completed = 0;
  options.onProgress?.({ completed, total: plans.length, ratio: 0 });

  for (const plan of plans) {
    throwIfAborted(options.signal);
    const tile = extractTile(pixels, width, height, plan.rect);
    const input = resampleRgba(tile, plan.rect.width, plan.rect.height, modelSize, modelSize);
    const output = await run(input, modelSize, options.signal);
    throwIfAborted(options.signal);
    if (output.length !== modelSize * modelSize * 4) {
      throw new RangeError(`Model returned ${output.length} bytes, expected ${modelSize * modelSize * 4} for ${modelSize}x${modelSize} RGBA`);
    }
    compositor.add(resampleRgba(output, modelSize, modelSize, plan.rect.width, plan.rect.height), plan, overlap);
    completed += 1;
    options.onProgress?.({ completed, total: plans.length, ratio: completed / plans.length });
  }
  return compositor.finish();
}

export { InferenceCancelledError };
