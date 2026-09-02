import type { RasterDocumentState, RasterRect, RgbaColor } from "./types";
import { renderLayerEffects } from "./effects";
import { applyAdjustment } from "./adjustments";
import { effectiveLayerOpacity, flattenRasterLayers, isLayerEffectivelyVisible } from "./layer-tree";

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

/** Clamps a requested region to the document, snapping to whole pixels. */
export function clampRegionToDocument(state: RasterDocumentState, region: RasterRect): RasterRect {
  const x = Math.max(0, Math.min(state.width, Math.floor(region.x)));
  const y = Math.max(0, Math.min(state.height, Math.floor(region.y)));
  const right = Math.max(x, Math.min(state.width, Math.ceil(region.x + region.width)));
  const bottom = Math.max(y, Math.min(state.height, Math.ceil(region.y + region.height)));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Composites the document inside `region` only, returning a buffer sized to that region.
 *
 * Interactive tools repaint a few hundred pixels around the cursor, so compositing the whole
 * canvas each frame is what makes brushes stutter on large documents. Layer pixels, masks and
 * adjustments are all addressed in document space while the output is addressed in region
 * space, which is the only subtlety here.
 */
export interface CompositeOptions {
  /** Sample every Nth pixel, producing a reduced-resolution result. Used for thumbnails and low zoom. */
  readonly step?: number;
}

export function compositeRasterRegion(state: RasterDocumentState, region: RasterRect, options: CompositeOptions = {}): Uint8ClampedArray {
  const { width } = state;
  const area = clampRegionToDocument(state, region);
  const step = Math.max(1, Math.floor(options.step ?? 1));
  const outWidth = Math.ceil(area.width / step), outHeight = Math.ceil(area.height / step);
  const output = new Uint8ClampedArray(outWidth * outHeight * 4);
  if (!area.width || !area.height) return output;
  const clippingBaseByParent = new Map<string, Uint8ClampedArray>();
  for (const layer of flattenRasterLayers(state.layers)) {
    const parentKey = layer.parentId ?? "root";
    const effectiveOpacity = effectiveLayerOpacity(layer, state.layers);
    if (layer.kind === "group" || !isLayerEffectivelyVisible(layer, state.layers) || effectiveOpacity <= 0) {
      if (layer.kind !== "group" && !layer.clipping) clippingBaseByParent.delete(parentKey);
      continue;
    }
    if (layer.kind === "adjustment" && layer.adjustment) {
      const clippingBase = layer.clipping ? clippingBaseByParent.get(parentKey) : undefined;
      const before = layer.mask?.enabled || clippingBase ? output.slice() : null;
      applyAdjustment(output, layer.adjustment, effectiveOpacity);
      if (before) for (let row = 0; row < outHeight; row += 1) for (let column = 0; column < outWidth; column += 1) {
        const index = (row * outWidth + column) * 4, documentIndex = (area.y + row * step) * width + (area.x + column * step);
        const sample = layer.mask?.enabled ? (layer.mask.inverted ? 255 - layer.mask.pixels[documentIndex]! : layer.mask.pixels[documentIndex]!) : 255;
        const amount = sample / 255 * (layer.mask?.density ?? 1) * (clippingBase ? clippingBase[row * outWidth + column]! / 255 : 1);
        output[index] = Math.round(before[index]! + (output[index]! - before[index]!) * amount);
        output[index + 1] = Math.round(before[index + 1]! + (output[index + 1]! - before[index + 1]!) * amount);
        output[index + 2] = Math.round(before[index + 2]! + (output[index + 2]! - before[index + 2]!) * amount);
        output[index + 3] = Math.round(before[index + 3]! + (output[index + 3]! - before[index + 3]!) * amount);
      }
      continue;
    }
    const renderedLayer = renderLayerEffects(layer, state.width, state.height);
    const clippingBase = layer.clipping ? clippingBaseByParent.get(parentKey) : undefined;
    const ownAlpha = layer.clipping ? null : new Uint8ClampedArray(outWidth * outHeight);
    for (let row = 0; row < outHeight; row += 1) for (let column = 0; column < outWidth; column += 1) {
      const regionIndex = row * outWidth + column, index = regionIndex * 4;
      const documentIndex = (area.y + row * step) * width + (area.x + column * step), sourceIndex = documentIndex * 4;
      const maskAlpha = layer.mask?.enabled ? ((layer.mask.inverted ? 255 - layer.mask.pixels[documentIndex]! : layer.mask.pixels[documentIndex]!) / 255) * layer.mask.density : 1;
      const baseAlpha = clippingBase ? clippingBase[regionIndex]! / 255 : layer.clipping ? 0 : 1;
      const rawAlpha = (renderedLayer[sourceIndex + 3]! / 255) * maskAlpha;
      if (ownAlpha) ownAlpha[regionIndex] = Math.round(rawAlpha * 255);
      const sourceAlpha = rawAlpha * baseAlpha * effectiveOpacity * (layer.fillOpacity ?? 1);
      if (sourceAlpha <= 0) continue;
      const destinationAlpha = output[index + 3]! / 255;
      const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      const blended = blendRgb(layer.blendMode, [renderedLayer[sourceIndex]!, renderedLayer[sourceIndex + 1]!, renderedLayer[sourceIndex + 2]!], [output[index]!, output[index + 1]!, output[index + 2]!]);
      output[index] = Math.round(clamp01((blended[0] * sourceAlpha + output[index]! * destinationAlpha * (1 - sourceAlpha)) / alpha / 255) * 255);
      output[index + 1] = Math.round(clamp01((blended[1] * sourceAlpha + output[index + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha / 255) * 255);
      output[index + 2] = Math.round(clamp01((blended[2] * sourceAlpha + output[index + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha / 255) * 255);
      output[index + 3] = Math.round(alpha * 255);
    }
    if (ownAlpha) clippingBaseByParent.set(parentKey, ownAlpha);
  }
  return output;
}

export function compositeRasterDocument(state: RasterDocumentState): Uint8ClampedArray {
  return compositeRasterRegion(state, { x: 0, y: 0, width: state.width, height: state.height });
}

export interface RasterThumbnail { pixels: Uint8ClampedArray; width: number; height: number }

/**
 * Composites the document straight into thumbnail resolution.
 *
 * Compositing at full size and then downscaling costs the same as a full repaint — over a
 * second on a large multi-layer document — which is far too much for a navigator preview that
 * refreshes on every edit. Sampling every Nth pixel makes the cost proportional to the
 * thumbnail instead of the canvas.
 */
export function compositeRasterThumbnail(state: RasterDocumentState, maxSize: number): RasterThumbnail {
  const step = Math.max(1, Math.ceil(Math.max(state.width, state.height) / Math.max(1, maxSize)));
  return {
    pixels: compositeRasterRegion(state, { x: 0, y: 0, width: state.width, height: state.height }, { step }),
    width: Math.ceil(state.width / step),
    height: Math.ceil(state.height / step),
  };
}

export function sampleAverage(pixels: Uint8ClampedArray, width: number, height: number, centerX: number, centerY: number, sampleSize = 1): RgbaColor {
  const radius = Math.floor(Math.max(1, sampleSize) / 2);
  let r = 0, g = 0, b = 0, a = 0, count = 0;
  for (let y = Math.max(0, Math.floor(centerY) - radius); y <= Math.min(height - 1, Math.floor(centerY) + radius); y += 1) for (let x = Math.max(0, Math.floor(centerX) - radius); x <= Math.min(width - 1, Math.floor(centerX) + radius); x += 1) {
    const index = (y * width + x) * 4; r += pixels[index]!; g += pixels[index + 1]!; b += pixels[index + 2]!; a += pixels[index + 3]!; count += 1;
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), a: Math.round(a / count) };
}
