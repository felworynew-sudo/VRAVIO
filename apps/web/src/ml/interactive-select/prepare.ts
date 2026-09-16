import { resampleRgba } from "@vravio/env-raster";
import type { SamPoint } from "./types";

/**
 * The pure pieces of talking to a SAM-family encoder/decoder pair — resize math, coordinate
 * rescaling, tensor packing, mask thresholding — kept separate from `run.ts`'s model-loading and
 * inference so each can be checked without a 40 MB model file, the same split every other `ml/*`
 * feature in this project already uses.
 */

export interface ResizedImage {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Resizes so the *longer* side becomes exactly `target`, preserving aspect ratio — Meta's own
 * `ResizeLongestSide`, which every SAM ONNX export's encoder assumes ran before its own padding. */
export function resizeLongestSide(pixels: Uint8ClampedArray, width: number, height: number, target: number): ResizedImage {
  const scale = target / Math.max(width, height);
  const resizedWidth = Math.max(1, Math.round(width * scale));
  const resizedHeight = Math.max(1, Math.round(height * scale));
  return { pixels: resampleRgba(pixels, width, height, resizedWidth, resizedHeight), width: resizedWidth, height: resizedHeight };
}

/** Packs RGB (alpha dropped — the encoder was never trained on transparency, the same reasoning
 * every other model in this codebase's own comments give) into the flat `[height, width, 3]`
 * layout `mobile-sam.ts`'s own doc comment confirms the encoder expects, raw 0..255 — the
 * ImageNet normalization is baked into the graph itself, not applied here. */
export function packEncoderInput(pixels: Uint8ClampedArray, width: number, height: number): Float32Array {
  const data = new Float32Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 3] = pixels[pixel * 4]!;
    data[pixel * 3 + 1] = pixels[pixel * 4 + 1]!;
    data[pixel * 3 + 2] = pixels[pixel * 4 + 2]!;
  }
  return data;
}

/** Rescales a point from the original image's own pixels into the encoder's resized space —
 * `point_coords`'s own contract (`mobile-sam.ts`'s doc comment): the decoder has no idea the
 * original image existed, only the resized-and-padded one the encoder actually saw. */
export function scalePointToEncoderSpace(point: SamPoint, originalWidth: number, originalHeight: number, encoderInputSize: number): SamPoint {
  const scale = encoderInputSize / Math.max(originalWidth, originalHeight);
  return { x: point.x * scale, y: point.y * scale, label: point.label };
}

/** SAM's own convention: the decoder's mask output is raw logits, not a probability — a pixel is
 * part of the mask where the logit is positive, full stop, not at some tuned threshold. */
export function thresholdMask(logits: Float32Array, width: number, height: number): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(width * height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = logits[index]! > 0 ? 255 : 0;
  return mask;
}
