import type { MLTensor } from "@vravio/kernel";

export type TensorLayout = "nchw" | "nhwc";

export interface ImageToTensorOptions {
  /** ONNX vision models almost all take NCHW; a few converted ones take NHWC. */
  readonly layout?: TensorLayout;
  /** Channels to emit: 3 drops alpha, 4 keeps it. */
  readonly channels?: 3 | 4;
  /** Subtracted per channel after scaling to 0..1. */
  readonly mean?: readonly number[];
  /** Divides per channel after the mean is subtracted. */
  readonly std?: readonly number[];
}

const broadcast = (values: readonly number[] | undefined, channels: number, fallback: number): number[] => {
  if (!values || values.length === 0) return Array.from({ length: channels }, () => fallback);
  if (values.length === 1) return Array.from({ length: channels }, () => values[0]!);
  if (values.length < channels) throw new RangeError(`Expected ${channels} values, got ${values.length}`);
  return [...values];
};

/**
 * Turns RGBA pixels into the tensor a vision model expects.
 *
 * Scaling, channel order and normalization are all per-model — u2net wants
 * ImageNet statistics, RMBG wants a plain half-and-half — and getting any of
 * them wrong produces a plausible-looking result that is quietly worse, which
 * is the sort of thing nobody notices for months. So none of it is assumed:
 * the caller states what the model was trained with.
 */
export function imageToTensor(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: ImageToTensorOptions = {},
): MLTensor {
  const channels = options.channels ?? 3;
  const layout = options.layout ?? "nchw";
  if (pixels.length !== width * height * 4) throw new RangeError(`Expected ${width * height * 4} bytes of RGBA, got ${pixels.length}`);

  const mean = broadcast(options.mean, channels, 0);
  const std = broadcast(options.std, channels, 1);
  for (const value of std) if (value === 0) throw new RangeError("Standard deviation of zero would divide by zero");

  const pixelCount = width * height;
  const data = new Float32Array(pixelCount * channels);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const source = pixel * 4;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = (pixels[source + channel]! / 255 - mean[channel]!) / std[channel]!;
      data[layout === "nchw" ? channel * pixelCount + pixel : pixel * channels + channel] = value;
    }
  }
  return {
    data,
    dims: layout === "nchw" ? [1, channels, height, width] : [1, height, width, channels],
  };
}

export interface TensorToMaskOptions {
  /** Where the single channel lives, when the tensor has more than one. */
  readonly channel?: number;
  /**
   * Rescale to use the full range.
   *
   * Segmentation models often return probabilities that never reach 0 or 1, and
   * a mask that tops out at 0.8 leaves the subject permanently translucent.
   */
  readonly normalize?: boolean;
}

/**
 * Reads a model's single-channel output as an 8-bit mask.
 *
 * Accepts the shapes these models actually produce — [1,1,h,w], [1,h,w],
 * [h,w] — rather than insisting on one, because which of them comes back
 * depends on how the model was exported and not on anything the caller chose.
 */
export function tensorToMask(tensor: MLTensor, width: number, height: number, options: TensorToMaskOptions = {}): Uint8ClampedArray {
  const pixelCount = width * height;
  const channel = options.channel ?? 0;
  const channels = channelCount(tensor.dims, pixelCount);
  if (tensor.data.length < pixelCount * channels) {
    throw new RangeError(`Tensor holds ${tensor.data.length} values, need ${pixelCount * channels} for ${width}x${height}`);
  }
  if (channel >= channels) throw new RangeError(`Tensor has ${channels} channel(s), asked for index ${channel}`);

  // Planar: every model that emits a mask emits it as one plane per channel.
  const offset = channel * pixelCount;
  let low = Infinity, high = -Infinity;
  if (options.normalize) {
    for (let index = 0; index < pixelCount; index += 1) {
      const value = tensor.data[offset + index]!;
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }
  const span = high - low;
  const mask = new Uint8ClampedArray(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const raw = tensor.data[offset + index]!;
    // A flat output has nothing to stretch; scaling it by 1/0 would be noise.
    const value = options.normalize && span > 1e-6 ? (raw - low) / span : raw;
    mask[index] = Math.round(Math.max(0, Math.min(1, value)) * 255);
  }
  return mask;
}

function channelCount(dims: readonly number[], pixelCount: number): number {
  const total = dims.reduce((product, size) => product * size, 1);
  if (pixelCount <= 0) return 1;
  return Math.max(1, Math.floor(total / pixelCount));
}

/**
 * Spreads a single-channel mask across RGBA so it can be tiled and blended.
 *
 * The tile compositor cross-fades RGBA; putting the mask in every channel lets
 * it do that without a second code path, and any channel reads back the same.
 */
export function maskToRgba(mask: Uint8ClampedArray): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(mask.length * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const target = index * 4, value = mask[index]!;
    rgba[target] = value; rgba[target + 1] = value; rgba[target + 2] = value; rgba[target + 3] = value;
  }
  return rgba;
}

/** Reads back a mask spread across RGBA by {@link maskToRgba}. */
export function rgbaToMaskChannel(rgba: Uint8ClampedArray, channel = 0): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(rgba.length / 4);
  for (let index = 0; index < mask.length; index += 1) mask[index] = rgba[index * 4 + channel]!;
  return mask;
}

/**
 * Resamples an RGBA image with bilinear interpolation.
 *
 * Models take a fixed input, and a tile that is not already that size has to be
 * resized before it goes in and the result resized back. Nearest-neighbour here
 * would put a staircase into every mask edge.
 */
export function resampleRgba(
  pixels: Uint8ClampedArray, width: number, height: number, targetWidth: number, targetHeight: number,
): Uint8ClampedArray {
  if (width === targetWidth && height === targetHeight) return pixels.slice();
  if (targetWidth < 1 || targetHeight < 1) throw new RangeError("Resample target must be at least one pixel");
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  // Map by pixel centres, so the first and last source pixels are not weighted
  // differently from the ones between them.
  const scaleX = width / targetWidth, scaleY = height / targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.max(0, Math.min(height - 1, (y + .5) * scaleY - .5));
    const y0 = Math.floor(sourceY), y1 = Math.min(height - 1, y0 + 1), fy = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.max(0, Math.min(width - 1, (x + .5) * scaleX - .5));
      const x0 = Math.floor(sourceX), x1 = Math.min(width - 1, x0 + 1), fx = sourceX - x0;
      const target = (y * targetWidth + x) * 4;
      const topLeft = (y0 * width + x0) * 4, topRight = (y0 * width + x1) * 4;
      const bottomLeft = (y1 * width + x0) * 4, bottomRight = (y1 * width + x1) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = pixels[topLeft + channel]! + (pixels[topRight + channel]! - pixels[topLeft + channel]!) * fx;
        const bottom = pixels[bottomLeft + channel]! + (pixels[bottomRight + channel]! - pixels[bottomLeft + channel]!) * fx;
        output[target + channel] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return output;
}
