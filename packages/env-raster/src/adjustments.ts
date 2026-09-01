import type { RasterAdjustment } from "./types";

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

export function adjustRgb(r: number, g: number, b: number, adjustment: RasterAdjustment): [number, number, number] {
  if (adjustment.kind === "invert") return [255 - r, 255 - g, 255 - b];
  if (adjustment.kind === "levels") {
    const apply = (value: number) => { const normalized = Math.max(0, Math.min(1, (value - adjustment.blackInput) / Math.max(1, adjustment.whiteInput - adjustment.blackInput))); return byte(adjustment.blackOutput + normalized ** (1 / Math.max(.01, adjustment.gamma)) * (adjustment.whiteOutput - adjustment.blackOutput)); };
    return [apply(r), apply(g), apply(b)];
  }
  if (adjustment.kind === "curves") { const lut = buildCurveLut(adjustment.points); return [lut[r]!, lut[g]!, lut[b]!]; }
  if (adjustment.kind === "colorBalance") return [byte(r + adjustment.cyanRed * 2.55), byte(g + adjustment.magentaGreen * 2.55), byte(b + adjustment.yellowBlue * 2.55)];
  if (adjustment.kind === "posterize") { const denominator = Math.max(1, Math.round(adjustment.levels) - 1), apply = (value: number) => byte(Math.round(value * denominator / 255) * 255 / denominator); return [apply(r), apply(g), apply(b)]; }
  if (adjustment.kind === "threshold") { const value = (r * 30 + g * 59 + b * 11) / 100 >= adjustment.threshold ? 255 : 0; return [value, value, value]; }
  if (adjustment.kind === "brightnessContrast") {
    const brightness = adjustment.brightness * 2.55, contrast = Math.max(-255, Math.min(255, adjustment.contrast * 2.55)), factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    const apply = (value: number) => byte(factor * (value + brightness - 128) + 128); return [apply(r), apply(g), apply(b)];
  }
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb((h + adjustment.hue / 360 + 1) % 1, Math.max(0, Math.min(1, s * (1 + adjustment.saturation / 100))), Math.max(0, Math.min(1, l + adjustment.lightness / 100)));
}

export function applyAdjustment(pixels: Uint8ClampedArray, adjustment: RasterAdjustment, opacity = 1): void {
  const mix = Math.max(0, Math.min(1, opacity));
  for (let index = 0; index < pixels.length; index += 4) {
    if (!pixels[index + 3]) continue;
    const [r, g, b] = adjustRgb(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!, adjustment);
    pixels[index] = byte(pixels[index]! + (r - pixels[index]!) * mix);
    pixels[index + 1] = byte(pixels[index + 1]! + (g - pixels[index + 1]!) * mix);
    pixels[index + 2] = byte(pixels[index + 2]! + (b - pixels[index + 2]!) * mix);
  }
}
