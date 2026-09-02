import type { RasterDocumentState, RasterLayer, RasterRect, RgbaColor } from "./types";
import { renderLayerEffects } from "./effects";
import { applyAdjustment } from "./adjustments";
import { effectiveLayerOpacity, flattenRasterLayers, isLayerEffectivelyVisible } from "./layer-tree";

/**
 * Blend modes as integers.
 *
 * The compositor dispatches on the mode once per pixel per channel. Comparing
 * strings there cost more than the arithmetic it selected, so the mode is
 * resolved to a number once per layer and the inner loop switches on that.
 */
const NORMAL = 0, DARKEN = 1, MULTIPLY = 2, COLOR_BURN = 3, LINEAR_BURN = 4, LIGHTEN = 5, SCREEN = 6,
  COLOR_DODGE = 7, LINEAR_DODGE = 8, OVERLAY = 9, SOFT_LIGHT = 10, HARD_LIGHT = 11, VIVID_LIGHT = 12,
  LINEAR_LIGHT = 13, PIN_LIGHT = 14, HARD_MIX = 15, DIFFERENCE = 16, EXCLUSION = 17, SUBTRACT = 18,
  DIVIDE = 19, HUE = 20, SATURATION = 21, COLOR = 22, LUMINOSITY = 23, DARKER_COLOR = 24, LIGHTER_COLOR = 25;

const blendCodes: Record<string, number> = {
  darken: DARKEN, multiply: MULTIPLY, colorBurn: COLOR_BURN, linearBurn: LINEAR_BURN,
  lighten: LIGHTEN, screen: SCREEN, colorDodge: COLOR_DODGE, linearDodge: LINEAR_DODGE,
  overlay: OVERLAY, softLight: SOFT_LIGHT, hardLight: HARD_LIGHT, vividLight: VIVID_LIGHT,
  linearLight: LINEAR_LIGHT, pinLight: PIN_LIGHT, hardMix: HARD_MIX, difference: DIFFERENCE,
  exclusion: EXCLUSION, subtract: SUBTRACT, divide: DIVIDE, hue: HUE, saturation: SATURATION,
  color: COLOR, luminosity: LUMINOSITY, darkerColor: DARKER_COLOR, lighterColor: LIGHTER_COLOR,
};

/** Modes that mix whole colours rather than each channel on its own. */
const isNonSeparable = (code: number) => code >= HUE;

/** Unknown modes composite as `normal`, which is what `dissolve` currently does. */
const blendCode = (mode: string): number => blendCodes[mode] ?? NORMAL;

function blendChannel(code: number, source: number, destination: number): number {
  const s = source / 255, d = destination / 255;
  switch (code) {
    case DARKEN: return Math.min(source, destination);
    case MULTIPLY: return s * d * 255;
    case COLOR_BURN: return (s <= 0 ? 0 : 1 - Math.min(1, (1 - d) / s)) * 255;
    case LINEAR_BURN: return Math.max(0, s + d - 1) * 255;
    case LIGHTEN: return Math.max(source, destination);
    case SCREEN: return (1 - (1 - s) * (1 - d)) * 255;
    case COLOR_DODGE: return (s >= 1 ? 1 : Math.min(1, d / (1 - s))) * 255;
    case LINEAR_DODGE: return Math.min(1, s + d) * 255;
    case OVERLAY: return (d <= .5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d)) * 255;
    case SOFT_LIGHT: return ((1 - 2 * s) * d * d + 2 * s * d) * 255;
    case HARD_LIGHT: return (s <= .5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d)) * 255;
    case VIVID_LIGHT: return (s <= .5 ? (s <= 0 ? 0 : 1 - Math.min(1, (1 - d) / (2 * s))) : (s >= 1 ? 1 : Math.min(1, d / (2 * (1 - s))))) * 255;
    case LINEAR_LIGHT: return Math.max(0, Math.min(1, d + 2 * s - 1)) * 255;
    case PIN_LIGHT: return (s <= .5 ? Math.min(d, 2 * s) : Math.max(d, 2 * s - 1)) * 255;
    case HARD_MIX: return blendChannel(VIVID_LIGHT, source, destination) < 128 ? 0 : 255;
    case DIFFERENCE: return Math.abs(destination - source);
    case EXCLUSION: return (s + d - 2 * s * d) * 255;
    case SUBTRACT: return Math.max(0, d - s) * 255;
    case DIVIDE: return (s <= 0 ? 1 : Math.min(1, d / s)) * 255;
    default: return source;
  }
}

/** Writes hue, saturation and lightness of an RGB triple into `out`. */
function rgbToHsl(r: number, g: number, b: number, out: Float64Array): void {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), lightness = (max + min) / 2;
  if (max === min) { out[0] = 0; out[1] = 0; out[2] = lightness; return; }
  const delta = max - min;
  out[1] = lightness > .5 ? delta / (2 - max - min) : delta / (max + min);
  out[0] = max === red ? ((green - blue) / delta + (green < blue ? 6 : 0)) / 6 : max === green ? ((blue - red) / delta + 2) / 6 : ((red - green) / delta + 4) / 6;
  out[2] = lightness;
}

/** Writes the RGB of an HSL triple into `out`. */
function hslToRgb(h: number, s: number, l: number, out: Float64Array): void {
  if (s === 0) { out[0] = l * 255; out[1] = l * 255; out[2] = l * 255; return; }
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (value: number) => { let t = value; if (t < 0) t += 1; if (t > 1) t -= 1; return (t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p) * 255; };
  out[0] = channel(h + 1 / 3); out[1] = channel(h); out[2] = channel(h - 1 / 3);
}

const luma = (r: number, g: number, b: number) => r * .2126 + g * .7152 + b * .0722;

/**
 * Blends a whole colour for the modes that cannot work channel by channel,
 * writing the result into `out`.
 *
 * The scratch buffers are passed in rather than allocated here: this runs once
 * per pixel, and returning a fresh triple made the compositor spend more time
 * in the garbage collector than in the blend.
 */
function blendNonSeparable(
  code: number,
  sr: number, sg: number, sb: number,
  dr: number, dg: number, db: number,
  out: Float64Array, sourceHsl: Float64Array, destinationHsl: Float64Array,
): void {
  if (code === DARKER_COLOR || code === LIGHTER_COLOR) {
    const sourceLuma = luma(sr, sg, sb), destinationLuma = luma(dr, dg, db);
    const takeSource = code === DARKER_COLOR ? sourceLuma < destinationLuma : sourceLuma > destinationLuma;
    out[0] = takeSource ? sr : dr; out[1] = takeSource ? sg : dg; out[2] = takeSource ? sb : db;
    return;
  }
  rgbToHsl(sr, sg, sb, sourceHsl);
  rgbToHsl(dr, dg, db, destinationHsl);
  if (code === HUE) hslToRgb(sourceHsl[0]!, destinationHsl[1]!, destinationHsl[2]!, out);
  else if (code === SATURATION) hslToRgb(destinationHsl[0]!, sourceHsl[1]!, destinationHsl[2]!, out);
  else if (code === COLOR) hslToRgb(sourceHsl[0]!, sourceHsl[1]!, destinationHsl[2]!, out);
  else hslToRgb(destinationHsl[0]!, destinationHsl[1]!, sourceHsl[2]!, out);
}

/**
 * The rectangle outside which a layer has no opaque pixels at all.
 *
 * Every shape and every piece of type lands on its own full-document layer, so
 * a working file accumulates dozens of layers that are empty almost everywhere.
 * The compositor was walking all of them for every tile: twenty-three layers of
 * two megapixels each, to draw a rectangle covering a twentieth of the canvas.
 * Knowing where a layer actually has content turns that into the two or three
 * layers that reach the tile.
 *
 * Scanning costs one pass over the buffer, and buffers are replaced rather than
 * written in place, so the answer is cached against the buffer itself and
 * survives for as long as the layer is unedited.
 */
const opaqueBounds = new WeakMap<Uint8ClampedArray, RasterRect | null>();

export function layerOpaqueBounds(pixels: Uint8ClampedArray, width: number, height: number): RasterRect | null {
  const cached = opaqueBounds.get(pixels);
  if (cached !== undefined) return cached;

  // Read four bytes at a time: the alpha test is the whole loop, and per-byte
  // indexing over two million pixels is most of its cost.
  const words = pixels.byteLength === width * height * 4 && pixels.byteOffset % 4 === 0
    ? new Uint32Array(pixels.buffer, pixels.byteOffset, width * height)
    : null;
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let rowLeft = -1, rowRight = -1;
    for (let x = 0; x < width; x += 1) {
      const opaque = words ? (words[row + x]! & 0xff000000) !== 0 : pixels[(row + x) * 4 + 3] !== 0;
      if (!opaque) continue;
      if (rowLeft < 0) rowLeft = x;
      rowRight = x;
    }
    if (rowLeft < 0) continue;
    if (y < top) top = y;
    bottom = y + 1;
    if (rowLeft < left) left = rowLeft;
    if (rowRight + 1 > right) right = rowRight + 1;
  }
  const bounds = right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  opaqueBounds.set(pixels, bounds);
  return bounds;
}

const overlaps = (a: RasterRect, b: RasterRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function hasEnabledEffect(layer: RasterLayer): boolean {
  const effects = layer.effects as Record<string, unknown> | undefined;
  if (!effects) return false;
  return Object.values(effects).some((effect) => typeof effect === "object" && effect !== null && (effect as { enabled?: boolean }).enabled === true);
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
  // Allocated once per composite rather than per pixel; see blendNonSeparable.
  const blendScratch = new Float64Array(3), sourceHsl = new Float64Array(3), destinationHsl = new Float64Array(3);
  const layers = [...flattenRasterLayers(state.layers)];
  // A layer only has to record its own coverage when something above it clips
  // to it. Recording it unconditionally costs a buffer and a write per pixel
  // per layer, which most documents never read back.
  const clippedParents = new Set<string>();
  for (const layer of layers) if (layer.clipping) clippedParents.add(layer.parentId ?? "root");

  for (const layer of layers) {
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
    // Nothing here reaches this region. An adjustment reads back what is under
    // it, an effect draws outside the layer's own pixels, and a layer something
    // clips to has to record its coverage even when empty — so none of those are
    // skipped; an ordinary layer with no opaque pixels in range contributes
    // exactly nothing and costs a rectangle test instead of a million reads.
    if (layer.kind !== "adjustment" && !layer.adjustment && !hasEnabledEffect(layer) && !clippedParents.has(parentKey)) {
      const bounds = layerOpaqueBounds(layer.pixels, width, state.height);
      if (!bounds || !overlaps(bounds, area)) continue;
    }

    const renderedLayer = renderLayerEffects(layer, state.width, state.height);
    const clippingBase = layer.clipping ? clippingBaseByParent.get(parentKey) : undefined;
    const ownAlpha = layer.clipping || !clippedParents.has(parentKey) ? null : new Uint8ClampedArray(outWidth * outHeight);
    // Everything constant for the layer is read once. Inside the loop these are
    // touched a few million times, and a property lookup there is not free.
    const code = blendCode(layer.blendMode);
    const nonSeparable = isNonSeparable(code);
    const mask = layer.mask?.enabled ? layer.mask : null;
    const maskPixels = mask?.pixels, maskInverted = mask?.inverted ?? false, maskDensity = mask?.density ?? 1;
    const layerAlpha = effectiveOpacity * (layer.fillOpacity ?? 1);
    const clipping = layer.clipping === true;
    const opaqueNormal = code === NORMAL && layerAlpha >= 1 && !clipping;

    for (let row = 0; row < outHeight; row += 1) {
      const documentRow = (area.y + row * step) * width + area.x;
      const outputRow = row * outWidth;
      for (let column = 0; column < outWidth; column += 1) {
        const regionIndex = outputRow + column, index = regionIndex * 4;
        const documentIndex = documentRow + column * step, sourceIndex = documentIndex * 4;
        const maskAlpha = maskPixels ? ((maskInverted ? 255 - maskPixels[documentIndex]! : maskPixels[documentIndex]!) / 255) * maskDensity : 1;
        const baseAlpha = clippingBase ? clippingBase[regionIndex]! / 255 : clipping ? 0 : 1;
        const rawAlpha = (renderedLayer[sourceIndex + 3]! / 255) * maskAlpha;
        if (ownAlpha) ownAlpha[regionIndex] = Math.round(rawAlpha * 255);
        const sourceAlpha = rawAlpha * baseAlpha * layerAlpha;
        if (sourceAlpha <= 0) continue;

        const sourceRed = renderedLayer[sourceIndex]!, sourceGreen = renderedLayer[sourceIndex + 1]!, sourceBlue = renderedLayer[sourceIndex + 2]!;
        if (opaqueNormal && sourceAlpha >= 1) {
          // Fully opaque `normal` pixels replace whatever is under them. The
          // general formula reduces to exactly this, and painting over an
          // opaque layer is the case a brush hits on almost every pixel.
          output[index] = sourceRed; output[index + 1] = sourceGreen; output[index + 2] = sourceBlue; output[index + 3] = 255;
          continue;
        }
        const destinationRed = output[index]!, destinationGreen = output[index + 1]!, destinationBlue = output[index + 2]!;
        let blendedRed: number, blendedGreen: number, blendedBlue: number;
        if (code === NORMAL) {
          // The overwhelmingly common case: the source colour passes through
          // untouched and only the Porter-Duff weighting below applies.
          blendedRed = sourceRed; blendedGreen = sourceGreen; blendedBlue = sourceBlue;
        } else if (nonSeparable) {
          blendNonSeparable(code, sourceRed, sourceGreen, sourceBlue, destinationRed, destinationGreen, destinationBlue, blendScratch, sourceHsl, destinationHsl);
          blendedRed = blendScratch[0]!; blendedGreen = blendScratch[1]!; blendedBlue = blendScratch[2]!;
        } else {
          blendedRed = blendChannel(code, sourceRed, destinationRed);
          blendedGreen = blendChannel(code, sourceGreen, destinationGreen);
          blendedBlue = blendChannel(code, sourceBlue, destinationBlue);
        }

        const destinationAlpha = output[index + 3]! / 255;
        const carry = destinationAlpha * (1 - sourceAlpha);
        const alpha = sourceAlpha + carry;
        // Uint8ClampedArray clamps on assignment, so only the rounding is
        // explicit here; it has to stay Math.round because the array itself
        // rounds halves to even and the recorded output depends on it.
        output[index] = Math.round((blendedRed * sourceAlpha + destinationRed * carry) / alpha);
        output[index + 1] = Math.round((blendedGreen * sourceAlpha + destinationGreen * carry) / alpha);
        output[index + 2] = Math.round((blendedBlue * sourceAlpha + destinationBlue * carry) / alpha);
        output[index + 3] = Math.round(alpha * 255);
      }
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
