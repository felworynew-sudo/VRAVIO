import { sampleColorLookup } from "./lut";
import { parseHexColor } from "./color";
import type { RasterAdjustment, SelectiveColorRange } from "./types";

const byte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

/** Natural cubic spline LUT, adapted from Patchy (MIT), adjustment_layer.cpp. */
export function buildCurveLut(points: Array<{ x: number; y: number }>): Uint8ClampedArray {
  const ordered = [...points].sort((a, b) => a.x - b.x);
  if (ordered.length < 2) return Uint8ClampedArray.from({ length: 256 }, (_, index) => index);
  const count = ordered.length, second = new Float64Array(count), work = new Float64Array(count - 1);
  for (let index = 1; index < count - 1; index += 1) {
    const span = Math.max(1e-9, ordered[index + 1]!.x - ordered[index - 1]!.x);
    const sigma = (ordered[index]!.x - ordered[index - 1]!.x) / span;
    const pivot = sigma * second[index - 1]! + 2;
    second[index] = (sigma - 1) / pivot;
    const left = (ordered[index]!.y - ordered[index - 1]!.y) / Math.max(1e-9, ordered[index]!.x - ordered[index - 1]!.x);
    const right = (ordered[index + 1]!.y - ordered[index]!.y) / Math.max(1e-9, ordered[index + 1]!.x - ordered[index]!.x);
    work[index] = (6 * (right - left) / span - sigma * work[index - 1]!) / pivot;
  }
  for (let index = count - 2; index >= 0; index -= 1) second[index] = second[index]! * second[index + 1]! + work[index]!;
  const lut = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value += 1) {
    if (value <= ordered[0]!.x) { lut[value] = byte(ordered[0]!.y); continue; }
    if (value >= ordered[count - 1]!.x) { lut[value] = byte(ordered[count - 1]!.y); continue; }
    let high = 1; while (ordered[high]!.x < value) high += 1;
    const low = high - 1, width = ordered[high]!.x - ordered[low]!.x;
    const a = (ordered[high]!.x - value) / width, b = (value - ordered[low]!.x) / width;
    lut[value] = byte(a * ordered[low]!.y + b * ordered[high]!.y + ((a ** 3 - a) * second[low]! + (b ** 3 - b) * second[high]!) * width ** 2 / 6);
  }
  return lut;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255, green = g / 255, blue = b / 255, max = Math.max(red, green, blue), min = Math.min(red, green, blue), light = (max + min) / 2;
  if (max === min) return [0, 0, light];
  const delta = max - min, saturation = light > .5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === red ? ((green - blue) / delta + (green < blue ? 6 : 0)) / 6 : max === green ? ((blue - red) / delta + 2) / 6 : ((red - green) / delta + 4) / 6;
  return [hue, saturation, light];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (offset: number) => { let t = h + offset; if (t < 0) t += 1; if (t > 1) t -= 1; return (t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p) * 255; };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

/**
 * Per-channel point functions for the adjustments whose output depends only on that
 * channel's own input value. Shared between `adjustRgb` (one call, one value) and
 * `buildPointLut` (256 calls, once, then indexed) below — same formula, two speeds.
 */
const levelsPoint = (adjustment: Extract<RasterAdjustment, { kind: "levels" }>) => (value: number): number => {
  const normalized = Math.max(0, Math.min(1, (value - adjustment.blackInput) / Math.max(1, adjustment.whiteInput - adjustment.blackInput)));
  return byte(adjustment.blackOutput + normalized ** (1 / Math.max(.01, adjustment.gamma)) * (adjustment.whiteOutput - adjustment.blackOutput));
};
const posterizePoint = (levels: number) => { const denominator = Math.max(1, Math.round(levels) - 1); return (value: number): number => byte(Math.round(value * denominator / 255) * 255 / denominator); };
const brightnessContrastPoint = (adjustment: Extract<RasterAdjustment, { kind: "brightnessContrast" }>) => {
  const brightness = adjustment.brightness * 2.55, contrast = Math.max(-255, Math.min(255, adjustment.contrast * 2.55)), factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  return (value: number): number => byte(factor * (value + brightness - 128) + 128);
};
const exposurePoint = (adjustment: Extract<RasterAdjustment, { kind: "exposure" }>) => (value: number): number =>
  byte(Math.max(0, (value / 255 * 2 ** adjustment.exposure + adjustment.offset)) ** (1 / Math.max(.01, adjustment.gamma)) * 255);

export function adjustRgb(r: number, g: number, b: number, adjustment: RasterAdjustment): [number, number, number] {
  if (adjustment.kind === "invert") return [255 - r, 255 - g, 255 - b];
  if (adjustment.kind === "levels") { const apply = levelsPoint(adjustment); return [apply(r), apply(g), apply(b)]; }
  if (adjustment.kind === "curves") { const lut = buildCurveLut(adjustment.points); return [lut[r]!, lut[g]!, lut[b]!]; }
  if (adjustment.kind === "colorBalance") return [byte(r + adjustment.cyanRed * 2.55), byte(g + adjustment.magentaGreen * 2.55), byte(b + adjustment.yellowBlue * 2.55)];
  if (adjustment.kind === "posterize") { const apply = posterizePoint(adjustment.levels); return [apply(r), apply(g), apply(b)]; }
  if (adjustment.kind === "threshold") { const value = (r * 30 + g * 59 + b * 11) / 100 >= adjustment.threshold ? 255 : 0; return [value, value, value]; }
  if (adjustment.kind === "brightnessContrast") { const apply = brightnessContrastPoint(adjustment); return [apply(r), apply(g), apply(b)]; }
  if (adjustment.kind === "exposure") { const apply = exposurePoint(adjustment); return [apply(r), apply(g), apply(b)]; }
  if (adjustment.kind === "vibrance") {
    const [h, s, l] = rgbToHsl(r, g, b), saturation = adjustment.saturation / 100, vibrance = adjustment.vibrance / 100;
    return hslToRgb(h, Math.max(0, Math.min(1, s + saturation * (saturation < 0 ? s : 1 - s) + vibrance * (1 - s) * .75)), l);
  }
  if (adjustment.kind === "blackWhite") {
    const [h] = rgbToHsl(r, g, b), weights = [adjustment.reds, adjustment.yellows, adjustment.greens, adjustment.cyans, adjustment.blues, adjustment.magentas, adjustment.reds], sector = h * 6, index = Math.floor(sector), mix = sector - index;
    const gray = byte((Math.max(r, g, b) * .65 + Math.min(r, g, b) * .35) * ((weights[index]! * (1 - mix) + weights[index + 1]! * mix) / 50));
    if (!adjustment.tint) return [gray, gray, gray]; const tint = parseHexColor(adjustment.tintColor), amount = .35; return [byte(gray * (1 - amount) + tint.r * amount), byte(gray * (1 - amount) + tint.g * amount), byte(gray * (1 - amount) + tint.b * amount)];
  }
  if (adjustment.kind === "photoFilter") {
    const filter = parseHexColor(adjustment.color), amount = Math.max(0, Math.min(1, adjustment.density / 100)), sourceLuma = r * .2126 + g * .7152 + b * .0722;
    let result: [number, number, number] = [r * (1 - amount) + filter.r * amount, g * (1 - amount) + filter.g * amount, b * (1 - amount) + filter.b * amount];
    if (adjustment.preserveLuminosity) { const outputLuma = result[0] * .2126 + result[1] * .7152 + result[2] * .0722, scale = sourceLuma / Math.max(1, outputLuma); result = [result[0] * scale, result[1] * scale, result[2] * scale]; }
    return result.map(byte) as [number, number, number];
  }
  if (adjustment.kind === "channelMixer") {
    if (adjustment.monochrome) { const gray = byte(r * .4 + g * .4 + b * .2); return [gray, gray, gray]; }
    const channel = (weights: [number, number, number, number]) => byte((r * weights[0] + g * weights[1] + b * weights[2]) / 100 + weights[3] * 2.55);
    return [channel(adjustment.red), channel(adjustment.green), channel(adjustment.blue)];
  }
  if (adjustment.kind === "gradientMap") {
    const from = parseHexColor(adjustment.reverse ? adjustment.to : adjustment.from), to = parseHexColor(adjustment.reverse ? adjustment.from : adjustment.to), luminance = (r * .2126 + g * .7152 + b * .0722) / 255;
    return [byte(from.r + (to.r - from.r) * luminance), byte(from.g + (to.g - from.g) * luminance), byte(from.b + (to.b - from.b) * luminance)];
  }
  if (adjustment.kind === "selectiveColor") {
    const [h, s, l] = rgbToHsl(r, g, b), centers: Partial<Record<SelectiveColorRange, number>> = { reds: 0, yellows: 1 / 6, greens: 2 / 6, cyans: 3 / 6, blues: 4 / 6, magentas: 5 / 6 };
    let outR = r, outG = g, outB = b;
    for (const range of Object.keys(adjustment.values) as SelectiveColorRange[]) {
      let weight: number; if (range === "whites") weight = Math.max(0, (l - .5) * 2); else if (range === "blacks") weight = Math.max(0, (.5 - l) * 2); else if (range === "neutrals") weight = 1 - Math.abs(l - .5) * 2; else { const center = centers[range]!, distance = Math.min(Math.abs(h - center), 1 - Math.abs(h - center)); weight = Math.max(0, 1 - distance * 6) * s; }
      const values = adjustment.values[range], scale = adjustment.method === "relative" ? weight : weight > 0 ? 1 : 0, black = values.black / 100;
      outR = outR * (1 - black * scale) - values.cyan * 2.55 * scale; outG = outG * (1 - black * scale) - values.magenta * 2.55 * scale; outB = outB * (1 - black * scale) - values.yellow * 2.55 * scale;
    }
    return [byte(outR), byte(outG), byte(outB)];
  }
  if (adjustment.kind === "shadowsHighlights") {
    const luma = (r * .2126 + g * .7152 + b * .0722) / 255, shadow = (1 - luma) ** 2 * adjustment.shadows / 100, highlight = luma ** 2 * adjustment.highlights / 100, contrast = 1 + adjustment.midtoneContrast / 100;
    const black = adjustment.blackClip / 100, white = adjustment.whiteClip / 100;
    const apply = (value: number) => byte(Math.max(0, Math.min(1, (((value / 255 + shadow * (1 - value / 255) - highlight * value / 255 - .5) * contrast + .5) - black) / Math.max(.01, 1 - black - white))) * 255);
    const corrected: [number, number, number] = [apply(r), apply(g), apply(b)], [h, s, l] = rgbToHsl(...corrected);
    return hslToRgb(h, Math.max(0, Math.min(1, s * (1 + adjustment.colorCorrection / 100))), l).map(byte) as [number, number, number];
  }
  if (adjustment.kind === "colorLookup") {
    const [outR, outG, outB] = sampleColorLookup(adjustment.lut, r, g, b);
    const mix = Math.max(0, Math.min(1, adjustment.amount));
    return [byte(r + (outR - r) * mix), byte(g + (outG - g) * mix), byte(b + (outB - b) * mix)];
  }
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb((h + adjustment.hue / 360 + 1) % 1, Math.max(0, Math.min(1, s * (1 + adjustment.saturation / 100))), Math.max(0, Math.min(1, l + adjustment.lightness / 100)));
}

function mapLut(apply: (value: number) => number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value += 1) lut[value] = apply(value);
  return lut;
}

/**
 * Adjustments whose every output channel is a pure function of that channel's own input —
 * levels, curves, posterize, brightness/contrast, exposure, invert, color balance — reduce to
 * one or three 256-entry lookup tables built once and indexed per pixel, instead of
 * recomputing the formula (a full cubic-spline solve, for curves) on every one of what can be
 * several million pixels. This is the difference between an adjustment layer that scrubs live
 * and one that doesn't — GIMP and Patchy both build the table once per edit for exactly this
 * reason. Anything whose output genuinely mixes more than one input channel (hue/saturation,
 * channel mixer, selective color, ...) has no such reduction and stays per-pixel in `adjustRgb`.
 */
function buildPointLut(adjustment: RasterAdjustment): readonly [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] | null {
  switch (adjustment.kind) {
    case "invert": { const lut = mapLut((value) => 255 - value); return [lut, lut, lut]; }
    case "curves": { const lut = buildCurveLut(adjustment.points); return [lut, lut, lut]; }
    case "levels": { const lut = mapLut(levelsPoint(adjustment)); return [lut, lut, lut]; }
    case "posterize": { const lut = mapLut(posterizePoint(adjustment.levels)); return [lut, lut, lut]; }
    case "brightnessContrast": { const lut = mapLut(brightnessContrastPoint(adjustment)); return [lut, lut, lut]; }
    case "exposure": { const lut = mapLut(exposurePoint(adjustment)); return [lut, lut, lut]; }
    case "colorBalance": return [mapLut((value) => byte(value + adjustment.cyanRed * 2.55)), mapLut((value) => byte(value + adjustment.magentaGreen * 2.55)), mapLut((value) => byte(value + adjustment.yellowBlue * 2.55))];
    default: return null;
  }
}

export function applyAdjustment(pixels: Uint8ClampedArray, adjustment: RasterAdjustment, opacity = 1): void {
  const mix = Math.max(0, Math.min(1, opacity));
  const lut = buildPointLut(adjustment);
  for (let index = 0; index < pixels.length; index += 4) {
    if (!pixels[index + 3]) continue;
    const [r, g, b] = lut ? [lut[0][pixels[index]!]!, lut[1][pixels[index + 1]!]!, lut[2][pixels[index + 2]!]!] : adjustRgb(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!, adjustment);
    const dither = adjustment.kind === "gradientMap" && adjustment.dither ? ((index / 4 * 73) % 5 - 2) * .35 : 0;
    pixels[index] = byte(pixels[index]! + (r - pixels[index]!) * mix + dither);
    pixels[index + 1] = byte(pixels[index + 1]! + (g - pixels[index + 1]!) * mix + dither);
    pixels[index + 2] = byte(pixels[index + 2]! + (b - pixels[index + 2]!) * mix + dither);
  }
}
