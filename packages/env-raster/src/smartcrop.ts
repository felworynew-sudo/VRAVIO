import type { RasterRect } from "./types";

export interface SmartCropOptions {
  /** Width divided by height of the wanted crop. */
  readonly aspect: number;
  /** Search granularity in analysis pixels; larger is faster and coarser. */
  readonly step?: number;
  /** Longest edge of the downsampled analysis image. */
  readonly analysisSize?: number;
}

export interface SmartCropResult {
  readonly rect: RasterRect;
  /** Mean saliency inside the chosen crop, for comparing candidates. */
  readonly score: number;
}

const luma = (r: number, g: number, b: number) => (r * 30 + g * 59 + b * 11) / 100;

/** Downsamples by point sampling; the saliency map does not need better filtering. */
function downsample(pixels: Uint8ClampedArray, width: number, height: number, maxEdge: number): { pixels: Uint8ClampedArray; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale)), outHeight = Math.max(1, Math.round(height * scale));
  const output = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) for (let x = 0; x < outWidth; x += 1) {
    const sourceX = Math.min(width - 1, Math.floor(x / scale)), sourceY = Math.min(height - 1, Math.floor(y / scale));
    const source = (sourceY * width + sourceX) * 4, target = (y * outWidth + x) * 4;
    output.set(pixels.subarray(source, source + 4), target);
  }
  return { pixels: output, width: outWidth, height: outHeight };
}

/**
 * Per-pixel "interestingness", combining edge energy, colour saturation and a skin-tone bonus.
 *
 * This is the classic smartcrop.js approach: no model, no download, and it beats face
 * detection on landscapes and product shots where there is no face to find.
 */
export function saliencyMap(pixels: Uint8ClampedArray, width: number, height: number): Float32Array {
  const map = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    const r = pixels[index]!, g = pixels[index + 1]!, b = pixels[index + 2]!, alpha = pixels[index + 3]! / 255;
    if (alpha <= 0) continue;

    const centre = luma(r, g, b);
    const right = x + 1 < width ? luma(pixels[index + 4]!, pixels[index + 5]!, pixels[index + 6]!) : centre;
    const below = y + 1 < height ? luma(pixels[index + width * 4]!, pixels[index + width * 4 + 1]!, pixels[index + width * 4 + 2]!) : centre;
    const edge = (Math.abs(centre - right) + Math.abs(centre - below)) / 255;

    const maximum = Math.max(r, g, b), minimum = Math.min(r, g, b);
    const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;

    // Rough skin range in normalized RGB; a weak nudge, not a detector.
    const total = r + g + b || 1;
    const skin = r / total > .35 && r / total < .5 && g / total > .28 && g / total < .36 && r > g && g > b ? .35 : 0;

    map[y * width + x] = (edge * 1.6 + saturation * .6 + skin) * alpha;
  }
  return map;
}

/**
 * Finds the highest-scoring crop of the requested aspect ratio.
 *
 * Candidates are scored on mean saliency with a mild centre bias, so an image with nothing
 * interesting in it still returns a sensibly centred crop rather than a corner.
 */
export function findSmartCrop(pixels: Uint8ClampedArray, width: number, height: number, options: SmartCropOptions): SmartCropResult {
  const aspect = options.aspect > 0 ? options.aspect : 1;
  const analysis = downsample(pixels, width, height, options.analysisSize ?? 180);
  const map = saliencyMap(analysis.pixels, analysis.width, analysis.height);

  // Integral image so any candidate's sum costs four lookups instead of a full scan.
  const integralWidth = analysis.width + 1;
  const integral = new Float64Array(integralWidth * (analysis.height + 1));
  for (let y = 0; y < analysis.height; y += 1) for (let x = 0; x < analysis.width; x += 1) {
    integral[(y + 1) * integralWidth + x + 1] = map[y * analysis.width + x]!
      + integral[y * integralWidth + x + 1]! + integral[(y + 1) * integralWidth + x]! - integral[y * integralWidth + x]!;
  }
  const areaSum = (x: number, y: number, w: number, h: number): number =>
    integral[(y + h) * integralWidth + x + w]! - integral[y * integralWidth + x + w]! - integral[(y + h) * integralWidth + x]! + integral[y * integralWidth + x]!;

  const step = Math.max(1, Math.floor(options.step ?? Math.max(2, Math.round(Math.max(analysis.width, analysis.height) / 40))));
  let best = { x: 0, y: 0, width: analysis.width, height: analysis.height, score: -1 };

  for (let scale = 1; scale >= .3; scale -= .1) {
    let cropWidth = Math.round(analysis.width * scale);
    let cropHeight = Math.round(cropWidth / aspect);
    if (cropHeight > analysis.height) { cropHeight = Math.round(analysis.height * scale); cropWidth = Math.round(cropHeight * aspect); }
    if (cropWidth < 4 || cropHeight < 4 || cropWidth > analysis.width || cropHeight > analysis.height) continue;

    for (let y = 0; y + cropHeight <= analysis.height; y += step) for (let x = 0; x + cropWidth <= analysis.width; x += step) {
      const mean = areaSum(x, y, cropWidth, cropHeight) / (cropWidth * cropHeight);
      const centreX = (x + cropWidth / 2) / analysis.width - .5, centreY = (y + cropHeight / 2) / analysis.height - .5;
      const centreBias = 1 - Math.min(1, Math.hypot(centreX, centreY)) * .18;
      const score = mean * centreBias;
      if (score > best.score) best = { x, y, width: cropWidth, height: cropHeight, score };
    }
  }

  const scaleX = width / analysis.width, scaleY = height / analysis.height;
  const rect: RasterRect = {
    x: Math.max(0, Math.round(best.x * scaleX)),
    y: Math.max(0, Math.round(best.y * scaleY)),
    width: Math.min(width, Math.round(best.width * scaleX)),
    height: Math.min(height, Math.round(best.height * scaleY)),
  };
  return {
    rect: {
      ...rect,
      x: Math.min(rect.x, width - rect.width),
      y: Math.min(rect.y, height - rect.height),
    },
    score: Math.max(0, best.score),
  };
}
