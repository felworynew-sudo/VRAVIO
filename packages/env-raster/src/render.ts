import type { RasterDocumentState, RgbaColor } from "./types";
import { renderLayerEffects } from "./effects";
import { applyAdjustment } from "./adjustments";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function blendChannel(mode: string, source: number, destination: number): number {
  const s = source / 255, d = destination / 255;
  if (mode === "darken") return Math.min(source, destination);
  if (mode === "multiply") return s * d * 255;
  if (mode === "colorBurn") return (s <= 0 ? 0 : 1 - Math.min(1, (1 - d) / s)) * 255;
  if (mode === "linearBurn") return Math.max(0, s + d - 1) * 255;
  if (mode === "lighten") return Math.max(source, destination);
  if (mode === "screen") return (1 - (1 - s) * (1 - d)) * 255;
  if (mode === "colorDodge") return (s >= 1 ? 1 : Math.min(1, d / (1 - s))) * 255;
  if (mode === "linearDodge") return Math.min(1, s + d) * 255;
  if (mode === "overlay") return (d <= .5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d)) * 255;
  if (mode === "softLight") return ((1 - 2 * s) * d * d + 2 * s * d) * 255;
  if (mode === "hardLight") return (s <= .5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d)) * 255;
  if (mode === "vividLight") return (s <= .5 ? (s <= 0 ? 0 : 1 - Math.min(1, (1 - d) / (2 * s))) : (s >= 1 ? 1 : Math.min(1, d / (2 * (1 - s))))) * 255;
  if (mode === "linearLight") return Math.max(0, Math.min(1, d + 2 * s - 1)) * 255;
  if (mode === "pinLight") return (s <= .5 ? Math.min(d, 2 * s) : Math.max(d, 2 * s - 1)) * 255;
  if (mode === "hardMix") return blendChannel("vividLight", source, destination) < 128 ? 0 : 255;
  if (mode === "difference") return Math.abs(destination - source);
  if (mode === "exclusion") return (s + d - 2 * s * d) * 255;
  if (mode === "subtract") return Math.max(0, d - s) * 255;
  if (mode === "divide") return (s <= 0 ? 1 : Math.min(1, d / s)) * 255;
  return source;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255, green = g / 255, blue = b / 255, max = Math.max(red, green, blue), min = Math.min(red, green, blue), lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min, saturation = lightness > .5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === red ? ((green - blue) / delta + (green < blue ? 6 : 0)) / 6 : max === green ? ((blue - red) / delta + 2) / 6 : ((red - green) / delta + 4) / 6;
  return [hue, saturation, lightness];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (value: number) => { let t = value; if (t < 0) t += 1; if (t > 1) t -= 1; return (t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p) * 255; };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

function blendRgb(mode: string, source: [number, number, number], destination: [number, number, number]): [number, number, number] {
  if (mode === "darkerColor" || mode === "lighterColor") {
    const sourceLuma = source[0] * .2126 + source[1] * .7152 + source[2] * .0722, destinationLuma = destination[0] * .2126 + destination[1] * .7152 + destination[2] * .0722;
    return mode === "darkerColor" ? (sourceLuma < destinationLuma ? source : destination) : (sourceLuma > destinationLuma ? source : destination);
  }
  if (["hue", "saturation", "color", "luminosity"].includes(mode)) {
    const [sh, ss, sl] = rgbToHsl(...source), [dh, ds, dl] = rgbToHsl(...destination);
    if (mode === "hue") return hslToRgb(sh, ds, dl);
    if (mode === "saturation") return hslToRgb(dh, ss, dl);
    if (mode === "color") return hslToRgb(sh, ss, dl);
    return hslToRgb(dh, ds, sl);
  }
  return [blendChannel(mode, source[0], destination[0]), blendChannel(mode, source[1], destination[1]), blendChannel(mode, source[2], destination[2])];
}

export function compositeRasterDocument(state: RasterDocumentState): Uint8ClampedArray {
  const output = new Uint8ClampedArray(state.width * state.height * 4);
  for (const layer of state.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    if (layer.kind === "adjustment" && layer.adjustment) {
      applyAdjustment(output, layer.adjustment, layer.opacity);
      continue;
    }
    const renderedLayer = renderLayerEffects(layer, state.width, state.height);
    for (let index = 0; index < output.length; index += 4) {
      const sourceAlpha = (renderedLayer[index + 3]! / 255) * layer.opacity * (layer.fillOpacity ?? 1);
      if (sourceAlpha <= 0) continue;
      const destinationAlpha = output[index + 3]! / 255;
      const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      const blended = blendRgb(layer.blendMode, [renderedLayer[index]!, renderedLayer[index + 1]!, renderedLayer[index + 2]!], [output[index]!, output[index + 1]!, output[index + 2]!]);
      output[index] = Math.round(clamp01((blended[0] * sourceAlpha + output[index]! * destinationAlpha * (1 - sourceAlpha)) / alpha / 255) * 255);
      output[index + 1] = Math.round(clamp01((blended[1] * sourceAlpha + output[index + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha / 255) * 255);
      output[index + 2] = Math.round(clamp01((blended[2] * sourceAlpha + output[index + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha / 255) * 255);
      output[index + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}

export function sampleAverage(pixels: Uint8ClampedArray, width: number, height: number, centerX: number, centerY: number, sampleSize = 1): RgbaColor {
  const radius = Math.floor(Math.max(1, sampleSize) / 2);
  let r = 0, g = 0, b = 0, a = 0, count = 0;
  for (let y = Math.max(0, Math.floor(centerY) - radius); y <= Math.min(height - 1, Math.floor(centerY) + radius); y += 1) for (let x = Math.max(0, Math.floor(centerX) - radius); x <= Math.min(width - 1, Math.floor(centerX) + radius); x += 1) {
    const index = (y * width + x) * 4; r += pixels[index]!; g += pixels[index + 1]!; b += pixels[index + 2]!; a += pixels[index + 3]!; count += 1;
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), a: Math.round(a / count) };
}
