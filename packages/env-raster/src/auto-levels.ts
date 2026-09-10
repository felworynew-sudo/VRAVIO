import type { LevelsChannelPoints, RasterAdjustment, RgbaColor } from "./types";

/**
 * Photoshop's own four Auto Color Correction Options models (Image >
 * Adjustments > Levels' "Auto" button and its Options dialog), each backed
 * by the same primitive — a percentile-clipped histogram stretch — used
 * differently per model, not four separate hand-rolled heuristics:
 *
 * - `monochromaticContrast` ("Enhance Monochromatic Contrast", Auto
 *   Contrast's own algorithm): one clip point found on the combined R+G+B
 *   histogram, applied identically to every channel — preserves the
 *   original colour relationships.
 * - `perChannelContrast` ("Enhance Per Channel Contrast", Auto Tone): each
 *   channel clipped against its own histogram independently — maximises
 *   contrast, may shift the colour balance, which is why `levels`'s
 *   optional `channels` field (types.ts) exists at all.
 * - `findDarkLightColors` ("Find Dark & Light Colors", Auto Color): finds
 *   the *average* colour of the darkest and lightest clipped clusters
 *   (not just an intensity cutoff) and maps those two real, possibly
 *   colour-cast colours onto the target shadow/highlight colours —
 *   the one model useful with `snapNeutralMidtones`, since only here do the
 *   per-channel black/white points already carry the source's own cast for
 *   a midtone correction to cancel out.
 * - `brightnessContrast` ("Enhance Brightness and Contrast"): Adobe has not
 *   published this one's internals; implemented here as the same combined-
 *   histogram clip as `monochromaticContrast`, blended halfway back toward
 *   the identity mapping — a gentler auto than full-range Monochromatic
 *   Contrast, sharing its primitive rather than inventing an unrelated
 *   fourth algorithm. Flagged here, and to the owner, as the one model this
 *   file cannot claim is a verified reconstruction of Adobe's own code.
 *
 * None of this reaches for PatchMatch or any search over pixel content —
 * these are histogram statistics, the same building block GIMP's own
 * "Stretch Contrast"/White Balance operations (gimp/app/operations) use for
 * an auto-levels-shaped result.
 */
export type AutoLevelsModel = "monochromaticContrast" | "perChannelContrast" | "findDarkLightColors" | "brightnessContrast";

export interface AutoLevelsOptions {
  readonly model: AutoLevelsModel;
  /** Percent, 0–9.99 — the fraction of extreme shadow/highlight pixels ignored when finding the clip point. Photoshop's own default is 0.1 for both. */
  readonly shadowClip: number;
  readonly highlightClip: number;
  /** Only `findDarkLightColors` uses this — see the model's own doc above. */
  readonly snapNeutralMidtones: boolean;
  readonly targetShadow: RgbaColor;
  readonly targetMidtone: RgbaColor;
  readonly targetHighlight: RgbaColor;
}

export const defaultAutoLevelsOptions: AutoLevelsOptions = {
  model: "findDarkLightColors",
  shadowClip: 0.1,
  highlightClip: 0.1,
  snapNeutralMidtones: false,
  targetShadow: { r: 0, g: 0, b: 0, a: 255 },
  targetMidtone: { r: 128, g: 128, b: 128, a: 255 },
  targetHighlight: { r: 255, g: 255, b: 255, a: 255 },
};

const CHANNEL_OFFSET = { red: 0, green: 1, blue: 2 } as const;

function channelHistogram(pixels: Uint8ClampedArray, offset: 0 | 1 | 2): Uint32Array {
  const histogram = new Uint32Array(256);
  for (let base = 0; base < pixels.length; base += 4) {
    if (pixels[base + 3] === 0) continue;
    histogram[pixels[base + offset]!]!++;
  }
  return histogram;
}

/** The bin at or past which `clipPercent`% of the (non-transparent) pixel count has accumulated, from each end. */
function clipBounds(histogram: ArrayLike<number>, shadowClipPercent: number, highlightClipPercent: number): { low: number; high: number } {
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += histogram[i]!;
  if (total <= 0) return { low: 0, high: 255 };
  const shadowBudget = total * Math.max(0, shadowClipPercent) / 100, highlightBudget = total * Math.max(0, highlightClipPercent) / 100;
  let low = 0, cumulative = 0;
  for (; low < 255; low += 1) { cumulative += histogram[low]!; if (cumulative > shadowBudget) break; }
  let high = 255; cumulative = 0;
  for (; high > 0; high -= 1) { cumulative += histogram[high]!; if (cumulative > highlightBudget) break; }
  // A flat or nearly-flat image (a solid fill, a fully clipped selection) can
  // clip past itself — low ends up at or above high. Falling back to the
  // full range leaves the image alone rather than inverting or collapsing it.
  if (high <= low) return { low: 0, high: 255 };
  return { low, high };
}

function combinedHistogram(pixels: Uint8ClampedArray): Uint32Array {
  const r = channelHistogram(pixels, 0), g = channelHistogram(pixels, 1), b = channelHistogram(pixels, 2);
  const combined = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) combined[i] = r[i]! + g[i]! + b[i]!;
  return combined;
}

/** The average colour of the pixels at or past a clip threshold, on either the dark or the light side of `histogram`. */
function averageClusterColor(pixels: Uint8ClampedArray, histogram: ArrayLike<number>, clipPercent: number, side: "dark" | "light"): RgbaColor {
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += histogram[i]!;
  const budget = Math.max(1, total * Math.max(0, clipPercent) / 100);
  let cumulative = 0, threshold = side === "dark" ? 0 : 255;
  if (side === "dark") { for (; threshold < 255; threshold += 1) { cumulative += histogram[threshold]!; if (cumulative >= budget) break; } }
  else { for (; threshold > 0; threshold -= 1) { cumulative += histogram[threshold]!; if (cumulative >= budget) break; } }
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let base = 0; base < pixels.length; base += 4) {
    if (pixels[base + 3] === 0) continue;
    // Rounded the same way `combinedLuminanceHistogram` rounds when it built
    // the bin `threshold` came from — an unrounded comparison against a
    // rounded threshold silently drops every pixel sitting exactly on the
    // boundary bin, and a small enough cluster (found live, this test's own
    // fixture) can lose every one of its pixels that way, falling through to
    // the "found nothing" default instead of the cluster's real colour.
    const luma = Math.round(pixels[base]! * .2126 + pixels[base + 1]! * .7152 + pixels[base + 2]! * .0722);
    const included = side === "dark" ? luma <= threshold : luma >= threshold;
    if (!included) continue;
    sumR += pixels[base]!; sumG += pixels[base + 1]!; sumB += pixels[base + 2]!; count += 1;
  }
  if (count === 0) return side === "dark" ? { r: 0, g: 0, b: 0, a: 255 } : { r: 255, g: 255, b: 255, a: 255 };
  return { r: sumR / count, g: sumG / count, b: sumB / count, a: 255 };
}

function pointsFromRange(low: number, high: number, targetLow: number, targetHigh: number): LevelsChannelPoints {
  return { blackInput: low, whiteInput: Math.max(low + 1, high), gamma: 1, blackOutput: targetLow, whiteOutput: targetHigh };
}

function pointsFromTwoColors(darkValue: number, lightValue: number, targetDark: number, targetLight: number): LevelsChannelPoints {
  return { blackInput: Math.min(254, Math.round(darkValue)), whiteInput: Math.max(Math.round(darkValue) + 1, Math.round(lightValue)), gamma: 1, blackOutput: targetDark, whiteOutput: targetLight };
}

/** Where a value currently lands after `points`, used to solve the gamma `snapNeutralMidtones` adds on top. */
function mapThroughPoints(points: LevelsChannelPoints, value: number): number {
  const normalized = Math.max(0, Math.min(1, (value - points.blackInput) / Math.max(1, points.whiteInput - points.blackInput)));
  return points.blackOutput + normalized ** (1 / Math.max(.01, points.gamma)) * (points.whiteOutput - points.blackOutput);
}

/** Solves the gamma that sends `currentValue` (already inside 0..255) to `targetValue`, holding the black/white points fixed. */
function gammaForMidtone(points: LevelsChannelPoints, currentValue: number, targetValue: number): number {
  const range = points.whiteOutput - points.blackOutput;
  if (range === 0) return points.gamma;
  const normalized = Math.max(1e-4, Math.min(1 - 1e-4, (currentValue - points.blackOutput) / range));
  const targetNormalized = Math.max(1e-4, Math.min(1 - 1e-4, (targetValue - points.blackOutput) / range));
  // normalized ** (1/gamma) = targetNormalized  =>  1/gamma = log(targetNormalized) / log(normalized)
  const gamma = Math.log(normalized) / Math.log(targetNormalized);
  return Math.max(.1, Math.min(9.99, gamma));
}

/**
 * Computes the Levels points `model` would set — the "Auto" button's own
 * result, not applied to anything yet, so the same `RasterAdjustment` shape
 * the Levels dialog already edits can just take it as its next value.
 */
export function computeAutoLevels(pixels: Uint8ClampedArray, options: AutoLevelsOptions): RasterAdjustment & { kind: "levels" } {
  const { model, shadowClip, highlightClip, snapNeutralMidtones, targetShadow, targetMidtone, targetHighlight } = options;

  if (model === "perChannelContrast") {
    const perChannel = (offset: 0 | 1 | 2, targetLow: number, targetHigh: number) => {
      const { low, high } = clipBounds(channelHistogram(pixels, offset), shadowClip, highlightClip);
      return pointsFromRange(low, high, targetLow, targetHigh);
    };
    const red = perChannel(CHANNEL_OFFSET.red, targetShadow.r, targetHighlight.r);
    const green = perChannel(CHANNEL_OFFSET.green, targetShadow.g, targetHighlight.g);
    const blue = perChannel(CHANNEL_OFFSET.blue, targetShadow.b, targetHighlight.b);
    return { kind: "levels", ...green, channels: { red, green, blue } };
  }

  if (model === "findDarkLightColors") {
    const luma = combinedLuminanceHistogram(pixels);
    const dark = averageClusterColor(pixels, luma, shadowClip, "dark");
    const light = averageClusterColor(pixels, luma, highlightClip, "light");
    let red = pointsFromTwoColors(dark.r, light.r, targetShadow.r, targetHighlight.r);
    let green = pointsFromTwoColors(dark.g, light.g, targetShadow.g, targetHighlight.g);
    let blue = pointsFromTwoColors(dark.b, light.b, targetShadow.b, targetHighlight.b);
    if (snapNeutralMidtones) {
      const midCluster = averageMidtoneColor(pixels, luma);
      red = { ...red, gamma: gammaForMidtone(red, mapThroughPoints(red, midCluster.r), targetMidtone.r) };
      green = { ...green, gamma: gammaForMidtone(green, mapThroughPoints(green, midCluster.g), targetMidtone.g) };
      blue = { ...blue, gamma: gammaForMidtone(blue, mapThroughPoints(blue, midCluster.b), targetMidtone.b) };
    }
    return { kind: "levels", ...green, channels: { red, green, blue } };
  }

  // monochromaticContrast and brightnessContrast: one clip on the combined
  // histogram, applied identically to every channel — no `channels` override,
  // the master fields alone already describe the whole correction.
  const { low, high } = clipBounds(combinedHistogram(pixels), shadowClip, highlightClip);
  const master = model === "brightnessContrast"
    ? pointsFromRange(Math.round(low / 2), Math.round((high + 255) / 2), targetShadow.r, targetHighlight.r)
    : pointsFromRange(low, high, targetShadow.r, targetHighlight.r);
  return { kind: "levels", ...master };
}

function combinedLuminanceHistogram(pixels: Uint8ClampedArray): Uint32Array {
  const histogram = new Uint32Array(256);
  for (let base = 0; base < pixels.length; base += 4) {
    if (pixels[base + 3] === 0) continue;
    const luma = Math.round(pixels[base]! * .2126 + pixels[base + 1]! * .7152 + pixels[base + 2]! * .0722);
    histogram[Math.max(0, Math.min(255, luma))]!++;
  }
  return histogram;
}

/** The average colour of pixels within one standard deviation of mean luminance — Photoshop's "neutral midtones" are the bulk of the image, not literally its median pixel. */
function averageMidtoneColor(pixels: Uint8ClampedArray, lumaHistogram: ArrayLike<number>): RgbaColor {
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i += 1) { total += lumaHistogram[i]!; sum += lumaHistogram[i]! * i; }
  if (total === 0) return { r: 128, g: 128, b: 128, a: 255 };
  const mean = sum / total;
  let varianceSum = 0;
  for (let i = 0; i < 256; i += 1) varianceSum += lumaHistogram[i]! * (i - mean) ** 2;
  const stddev = Math.sqrt(varianceSum / total) || 1;
  const low = Math.max(0, mean - stddev), high = Math.min(255, mean + stddev);
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let base = 0; base < pixels.length; base += 4) {
    if (pixels[base + 3] === 0) continue;
    const luma = pixels[base]! * .2126 + pixels[base + 1]! * .7152 + pixels[base + 2]! * .0722;
    if (luma < low || luma > high) continue;
    sumR += pixels[base]!; sumG += pixels[base + 1]!; sumB += pixels[base + 2]!; count += 1;
  }
  return count === 0 ? { r: 128, g: 128, b: 128, a: 255 } : { r: sumR / count, g: sumG / count, b: sumB / count, a: 255 };
}
