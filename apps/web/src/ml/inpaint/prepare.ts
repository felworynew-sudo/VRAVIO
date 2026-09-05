import { resampleRgba } from "@vravio/env-raster";
import type { MLTensor } from "@vravio/kernel";
import type { InpaintModelDefinition, MaskMeaning, OutputRange, ValueRange } from "./types";

/**
 * Turning a marked region into what a model expects, and its answer back into
 * pixels.
 *
 * All of it pure, and all of it tested without a model file, because this is
 * where inpainting goes wrong quietly: an inverted mask, a value range off by
 * a factor, a result pasted back over the whole layer instead of the hole.
 * None of those throw. They just produce a picture that is subtly or
 * completely wrong, and no stack trace says why.
 */

/** Where the model ran, so its answer can be put back where it came from. */
export interface InpaintRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The smallest square-ish box around everything marked, padded for context.
 *
 * The model sees a fixed 512×512, so what matters is how much of the picture
 * is inside it. A tight crop around a small mark gives the model a lot of
 * pixels per millimetre and good context; feeding it the whole layer scaled
 * down to 512 throws that away. The padding is what gives it something to
 * continue *from* — a hole with no surroundings has nothing to infer.
 */
export function regionForMask(mask: Uint8ClampedArray, width: number, height: number, padding = 0.5): InpaintRegion | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  const markedWidth = maxX - minX + 1, markedHeight = maxY - minY + 1;
  // Square, because the model's input is: a non-square crop would be squashed
  // and the model would inpaint a distorted picture.
  const side = Math.max(markedWidth, markedHeight);
  const grown = Math.ceil(side * (1 + padding * 2));
  const centreX = minX + markedWidth / 2, centreY = minY + markedHeight / 2;

  const clamped = Math.min(grown, width, height);
  const x = Math.round(Math.max(0, Math.min(width - clamped, centreX - clamped / 2)));
  const y = Math.round(Math.max(0, Math.min(height - clamped, centreY - clamped / 2)));
  return { x, y, width: clamped, height: clamped };
}

/** Cuts a region out of an RGBA buffer. */
export function cropRgba(pixels: Uint8ClampedArray, width: number, region: InpaintRegion): Uint8ClampedArray {
  const out = new Uint8ClampedArray(region.width * region.height * 4);
  for (let y = 0; y < region.height; y += 1) {
    const from = ((region.y + y) * width + region.x) * 4;
    out.set(pixels.subarray(from, from + region.width * 4), y * region.width * 4);
  }
  return out;
}

/** The same for a one-byte-per-pixel mask. */
export function cropMask(mask: Uint8ClampedArray, width: number, region: InpaintRegion): Uint8ClampedArray {
  const out = new Uint8ClampedArray(region.width * region.height);
  for (let y = 0; y < region.height; y += 1) {
    const from = (region.y + y) * width + region.x;
    out.set(mask.subarray(from, from + region.width), y * region.width);
  }
  return out;
}

/** Nearest-neighbour, deliberately: a mask is a decision, not a picture, and
 * a smoothed edge would ask the model to half-fill a pixel. */
export function resampleMask(mask: Uint8ClampedArray, width: number, height: number, size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + .5) * height / size));
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + .5) * width / size));
      out[y * size + x] = mask[sourceY * width + sourceX]! > 127 ? 255 : 0;
    }
  }
  return out;
}

const scaleTo = (value: number, range: ValueRange): number => (range === "0..1" ? value / 255 : value / 127.5 - 1);

/** 1 where the model should treat the pixel as marked, per its own polarity. */
const maskValue = (marked: boolean, means: MaskMeaning): number =>
  (means === "one-is-fill" ? (marked ? 1 : 0) : (marked ? 0 : 1));

/**
 * Builds the tensors a model is fed, from a square RGBA crop already scaled to
 * the model's size and its matching mask.
 */
export function buildInpaintInput(
  rgba: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  model: InpaintModelDefinition,
): Record<string, MLTensor> {
  const size = model.size;
  const pixels = size * size;
  if (rgba.length !== pixels * 4) throw new RangeError(`Expected ${pixels * 4} bytes of RGBA, got ${rgba.length}`);
  if (mask.length !== pixels) throw new RangeError(`Expected a ${size}×${size} mask, got ${mask.length}`);

  const contract = model.input;
  if (contract.kind === "packed-mask-first") {
    const data = new Float32Array(pixels * 4);
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const marked = mask[pixel]! > 127;
      const value = maskValue(marked, contract.maskMeans);
      data[pixel] = value + contract.maskBias;
      for (let channel = 0; channel < 3; channel += 1) {
        const scaled = scaleTo(rgba[pixel * 4 + channel]!, contract.imageRange);
        // Multiplied by the mask, so the hole reaches the model as zero rather
        // than as the thing being removed.
        data[(channel + 1) * pixels + pixel] = contract.premultiply ? scaled * value : scaled;
      }
    }
    return { [contract.name]: { data, dims: [1, 4, size, size] } };
  }

  const image = new Float32Array(pixels * 3);
  const maskData = new Float32Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    maskData[pixel] = maskValue(mask[pixel]! > 127, contract.maskMeans);
    for (let channel = 0; channel < 3; channel += 1) {
      image[channel * pixels + pixel] = scaleTo(rgba[pixel * 4 + channel]!, contract.imageRange);
    }
  }
  return {
    [contract.imageName]: { data: image, dims: [1, 3, size, size] },
    [contract.maskName]: { data: maskData, dims: [1, 1, size, size] },
  };
}

const fromRange = (value: number, range: OutputRange): number =>
  range === "0..255" ? value : range === "0..1" ? value * 255 : (value * .5 + .5) * 255;

/**
 * Reads a model's output back into RGBA at the model's own size.
 *
 * Alpha is not something these models produce — they were trained on opaque
 * photographs — so it is carried over from the input rather than invented.
 */
export function readInpaintOutput(tensor: MLTensor, model: InpaintModelDefinition, source: Uint8ClampedArray): Uint8ClampedArray {
  const size = model.size, pixels = size * size;
  if (tensor.data.length < pixels * 3) throw new RangeError(`Model returned ${tensor.data.length} values, expected at least ${pixels * 3}`);

  const out = new Uint8ClampedArray(pixels * 4);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      out[pixel * 4 + channel] = Math.round(fromRange(tensor.data[channel * pixels + pixel]!, model.output.range));
    }
    out[pixel * 4 + 3] = source[pixel * 4 + 3]!;
  }
  return out;
}

/**
 * The opacity the filled area should end up with.
 *
 * The models know nothing about transparency — they were trained on opaque
 * photographs and return three channels. Carrying the original alpha through
 * unchanged is right for a photo and useless for a layer: marking a black
 * stroke on an empty layer gave the model a black surround, so it dutifully
 * filled the hole with black, and with the alpha kept at 255 the stroke stayed
 * exactly as visible as before. The brush appeared to do nothing.
 *
 * What the surroundings are is the answer. Alpha is inpainted the crudest
 * honest way — the mean opacity of the region's *unmarked* pixels — because
 * that is what "continue the surroundings" means for a channel the model
 * cannot see. On a photograph every neighbour is opaque and nothing changes;
 * on an empty layer every neighbour is transparent, so the marked pixels
 * become transparent and the stroke is gone.
 */
function surroundingAlpha(original: Uint8ClampedArray, width: number, height: number, mask: Uint8ClampedArray, region: InpaintRegion): number {
  let total = 0, counted = 0;
  for (let y = 0; y < region.height; y += 1) {
    const at = region.y + y;
    if (at < 0 || at >= height) continue;
    for (let x = 0; x < region.width; x += 1) {
      const ax = region.x + x;
      if (ax < 0 || ax >= width) continue;
      const index = at * width + ax;
      // Only pixels the user did not mark: the marked ones are what is being
      // replaced, and averaging them in would drag the answer back towards
      // the thing being removed.
      if (mask[index]! > 0) continue;
      total += original[index * 4 + 3]!;
      counted += 1;
    }
  }
  // A mark covering its whole region has no surroundings to speak of; leaving
  // the alpha alone is the least surprising thing to do.
  return counted ? total / counted : -1;
}

/**
 * Puts the filled region back, inside the mark and nowhere else.
 *
 * These models return a whole new picture, not a patch: every pixel differs a
 * little, including the ones nobody asked to change. Writing all of it back
 * would quietly resample the untouched part of the layer through two scalings.
 * Only the marked pixels are taken.
 *
 * The mask's own value feathers the join, so a soft-edged brush blends instead
 * of leaving a hard rectangle of slightly different pixels.
 */
export function compositeInpaint(
  original: Uint8ClampedArray,
  width: number,
  height: number,
  filledRegion: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  region: InpaintRegion,
): Uint8ClampedArray {
  const scaled = resampleRgba(filledRegion, region.width, region.height, region.width, region.height);
  const out = original.slice();
  const targetAlpha = surroundingAlpha(original, width, height, mask, region);
  for (let y = 0; y < region.height; y += 1) {
    const targetY = region.y + y;
    if (targetY < 0 || targetY >= height) continue;
    for (let x = 0; x < region.width; x += 1) {
      const targetX = region.x + x;
      if (targetX < 0 || targetX >= width) continue;
      const coverage = mask[targetY * width + targetX]! / 255;
      if (coverage <= 0) continue;
      const to = (targetY * width + targetX) * 4, from = (y * region.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        out[to + channel] = Math.round(out[to + channel]! + (scaled[from + channel]! - out[to + channel]!) * coverage);
      }
      if (targetAlpha >= 0) out[to + 3] = Math.round(out[to + 3]! + (targetAlpha - out[to + 3]!) * coverage);
    }
  }
  return out;
}
