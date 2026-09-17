import type { RasterDocumentState, RasterLayer, RasterLayerMask, RasterRect, RgbaColor } from "./types";
import { renderLayerEffects, requiredSourceRegion } from "./effects";
import { applyAdjustment } from "./adjustments";
import { applyRasterFilter } from "./filters";
import { effectiveLayerOpacity, flattenRasterLayers, isLayerEffectivelyVisible, rasterLayerDescendantIds } from "./layer-tree";
import { layerDocumentPixels, layerPixelsView } from "./layer-bounds";
import { EvictedTileStoreError, TileStore } from "./tile-store";

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
  DIVIDE = 19, HUE = 20, SATURATION = 21, COLOR = 22, LUMINOSITY = 23, DARKER_COLOR = 24, LIGHTER_COLOR = 25, DISSOLVE = 26;

const blendCodes: Record<string, number> = {
  darken: DARKEN, multiply: MULTIPLY, colorBurn: COLOR_BURN, linearBurn: LINEAR_BURN,
  lighten: LIGHTEN, screen: SCREEN, colorDodge: COLOR_DODGE, linearDodge: LINEAR_DODGE,
  overlay: OVERLAY, softLight: SOFT_LIGHT, hardLight: HARD_LIGHT, vividLight: VIVID_LIGHT,
  linearLight: LINEAR_LIGHT, pinLight: PIN_LIGHT, hardMix: HARD_MIX, difference: DIFFERENCE,
  exclusion: EXCLUSION, subtract: SUBTRACT, divide: DIVIDE, hue: HUE, saturation: SATURATION,
  color: COLOR, luminosity: LUMINOSITY, darkerColor: DARKER_COLOR, lighterColor: LIGHTER_COLOR, dissolve: DISSOLVE,
};

/** Modes that mix whole colours rather than each channel on its own. */
const isNonSeparable = (code: number) => code >= HUE;

/** Unknown modes composite as `normal`. */
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

/** Stable per-document-pixel noise for Photoshop-style Dissolve coverage. */
function dissolveNoise(x: number, y: number, layerIndex: number): number {
  let value = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ Math.imul(layerIndex, 0x6c8e9cf5);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

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
 *
 * Most callers pass a freshly materialised, never-mutated buffer, for which
 * identity alone is a fine cache key. The two callers that pass a persistent
 * `layer.pixels` buffer instead (this file's own `signatureRegion`, and
 * `move.tsx`'s read of the pixels a drag started from) also pass that layer's
 * `pixelsRevision` — the same replacement the other five caches in
 * docs/master-plan.md §37.6.2 already made — so a future in-place mutation of
 * that buffer still invalidates the cache. Callers with no revision to offer
 * pass none, which compares equal to itself and keeps today's identity-only
 * behaviour.
 */
const opaqueBounds = new WeakMap<Uint8ClampedArray, { width: number; height: number; revision: number; bounds: RasterRect | null }>();

export function layerOpaqueBounds(pixels: Uint8ClampedArray, width: number, height: number, revision = -1): RasterRect | null {
  // The geometry is part of the question, not just the buffer: the same buffer is
  // read at canvas size in one place and at its layer's own trimmed size in
  // another, and a cache keyed on the buffer alone would answer the second call
  // with the first one's rectangle.
  const cached = opaqueBounds.get(pixels);
  if (cached && cached.width === width && cached.height === height && cached.revision === revision) return cached.bounds;

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
  opaqueBounds.set(pixels, { width, height, revision, bounds });
  return bounds;
}

const overlaps = (a: RasterRect, b: RasterRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The rectangle two regions share, or `null` when they don't overlap at all. */
export function intersectRect(a: RasterRect, b: RasterRect): RasterRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

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
  /** One output pixel per N×N document pixels, averaged — a reduced-resolution result for thumbnails and low zoom. */
  readonly step?: number;
  /** @internal Take one sample per step instead of averaging; the averaging pass's own source. */
  readonly pointSample?: boolean;
  /** @internal The outer call supplied a blur-safe backdrop margin already. */
  readonly backdropContext?: boolean;
}

/** Glass needs a document-space source but does not itself alter that source. */
function hasRenderableEffect(layer: RasterLayer): boolean {
  return Object.entries(layer.effects ?? {}).some(([key, effect]) => key !== "glass" && typeof effect === "object" && effect !== null && (effect as { enabled?: boolean }).enabled === true);
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Cached non-destructive layer-mask feather. The source mask remains the
 * editable grayscale truth; only the compositor reads this softened view.
 * Keyed on the mask object, not its `pixels` buffer — `pixelsRevision`
 * (docs/master-plan.md §37.6.2) is what invalidates a radius's cached
 * result when the mask's content actually changes, the same replacement
 * `renderedEffects`/`materialised` above already made. */
const featheredMasks = new WeakMap<RasterLayerMask, { pixelsRevision: number; byRadius: Map<number, Uint8ClampedArray> }>();

function featherMask(mask: RasterLayerMask, width: number, height: number, feather: number): Uint8ClampedArray {
  const radius = Math.max(0, Math.min(64, Math.round(feather)));
  let entry = featheredMasks.get(mask);
  if (!entry || entry.pixelsRevision !== mask.pixelsRevision) { entry = { pixelsRevision: mask.pixelsRevision, byRadius: new Map() }; featheredMasks.set(mask, entry); }
  const cached = entry.byRadius.get(radius);
  if (cached) return cached;
  // `mask.tiles` is always exactly document-sized (unlike a layer's own bounds-cropped tiles),
  // so `toPixels()` here is the same one-time, cached-by-revision materialisation
  // `layerDocumentPixels` already does for a layer — not a per-frame cost, because `entry` above
  // already caches this same flat buffer keyed on `radius` (0 included) until `pixelsRevision`
  // moves. `radius === 0` used to skip this cache and return `mask.pixels` directly, back when
  // that was already a flat array with nothing to materialise; now that the source is tiled,
  // caching the unfiltered view the same way as every other radius is what keeps this a
  // once-per-edit cost instead of once-per-frame.
  if (!radius) {
    const flat = mask.tiles.toPixels();
    entry.byRadius.set(radius, flat);
    return flat;
  }
  const pixels = mask.tiles.toPixels();
  const horizontal = new Float32Array(pixels.length), output = new Uint8ClampedArray(pixels.length);
  const diameter = radius * 2 + 1;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) sum += pixels[y * width + clampX(offset)]!;
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / diameter;
      sum += pixels[y * width + clampX(x + radius + 1)]! - pixels[y * width + clampX(x - radius)]!;
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) sum += horizontal[clampY(offset) * width + x]!;
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = Math.round(sum / diameter);
      sum += horizontal[clampY(y + radius + 1) * width + x]! - horizontal[clampY(y - radius) * width + x]!;
    }
  }
  entry.byRadius.set(radius, output);
  return output;
}

function glassPadding(state: RasterDocumentState): number {
  let padding = 0;
  for (const layer of flattenRasterLayers(state.layers)) {
    const glass = layer.effects?.glass;
    if (glass?.enabled) padding = Math.max(padding, Math.min(32, Math.ceil(Math.max(0, glass.blur))));
  }
  return padding;
}

function cropComposite(source: Uint8ClampedArray, sourceArea: RasterRect, area: RasterRect): Uint8ClampedArray {
  const output = new Uint8ClampedArray(area.width * area.height * 4);
  const left = area.x - sourceArea.x, top = area.y - sourceArea.y;
  for (let row = 0; row < area.height; row += 1) {
    const from = ((top + row) * sourceArea.width + left) * 4;
    output.set(source.subarray(from, from + area.width * 4), row * area.width * 4);
  }
  return output;
}

/**
 * Averages each `factor`×`factor` block of `source` into one pixel, in premultiplied alpha — the
 * box filter GIMP builds its projection's mipmap levels with, and Krita's `KisImagePyramid` its
 * zoomed-out levels. Premultiplied so a transparent neighbour does not darken an edge. Blocks at
 * the right and bottom edges average only the pixels that exist.
 */
function boxDownsample(source: Uint8ClampedArray, width: number, height: number, factor: number): Uint8ClampedArray {
  const outWidth = Math.ceil(width / factor), outHeight = Math.ceil(height / factor);
  const output = new Uint8ClampedArray(outWidth * outHeight * 4);
  // The whole blocks, which is nearly all of them, in one flat loop without per-pixel bounds or a
  // nested block loop — this runs over every tile of a zoomed-out view. Edge blocks fall through.
  const wholeColumns = Math.floor(width / factor), wholeRows = Math.floor(height / factor), area = factor * factor;
  for (let row = 0; row < wholeRows; row += 1) {
    const rowStart = row * factor;
    for (let column = 0; column < wholeColumns; column += 1) {
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (let y = rowStart, yEnd = rowStart + factor; y < yEnd; y += 1) {
        let index = (y * width + column * factor) * 4;
        for (let x = 0; x < factor; x += 1, index += 4) {
          const a = source[index + 3]!;
          if (a === 0) continue;
          red += source[index]! * a; green += source[index + 1]! * a; blue += source[index + 2]! * a; alpha += a;
        }
      }
      const target = (row * outWidth + column) * 4;
      if (alpha > 0) { output[target] = red / alpha; output[target + 1] = green / alpha; output[target + 2] = blue / alpha; output[target + 3] = alpha / area; }
    }
  }
  for (let row = 0; row < outHeight; row += 1) {
    const top = row * factor, bottom = Math.min(height, top + factor);
    for (let column = row < wholeRows ? wholeColumns : 0; column < outWidth; column += 1) {
      const left = column * factor, right = Math.min(width, left + factor);
      let red = 0, green = 0, blue = 0, alpha = 0, count = 0;
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
        const index = (y * width + x) * 4, a = source[index + 3]!;
        red += source[index]! * a; green += source[index + 1]! * a; blue += source[index + 2]! * a; alpha += a; count += 1;
      }
      const target = (row * outWidth + column) * 4;
      if (alpha > 0) { output[target] = red / alpha; output[target + 1] = green / alpha; output[target + 2] = blue / alpha; }
      output[target + 3] = alpha / count;
    }
  }
  return output;
}

/**
 * Applies the expensive part of a Glass layer to the already-composited
 * backdrop. A small blur pyramid costs three linear passes over the current
 * region, rather than a different convolution for every brightness value.
 */
function applyGlassBackdrop(
  output: Uint8ClampedArray, width: number, height: number,
  layer: RasterLayer, renderedLayer: Uint8ClampedArray, area: RasterRect,
  stateWidth: number, sourceWidth: number, sourceOriginX: number, sourceOriginY: number,
  step: number, maskPixels: Uint8ClampedArray | undefined,
  maskDensity: number, clippingBase: Uint8ClampedArray | undefined,
  layerAlpha: number,
): void {
  const glass = layer.effects.glass!;
  const maxBlur = Math.min(32, Math.max(0, Math.round(glass.blur)));
  if (!maxBlur) return;
  // `output` changes below, so build all levels from its one immutable state.
  const low = applyRasterFilter(output, width, height, "box_blur", { radius: Math.max(1, Math.round(maxBlur / 3)) });
  const middle = applyRasterFilter(output, width, height, "box_blur", { radius: Math.max(1, Math.round(maxBlur * 2 / 3)) });
  const high = applyRasterFilter(output, width, height, "box_blur", { radius: maxBlur });
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    const documentX = area.x + column * step, documentY = area.y + row * step;
    // `renderedLayer` is `layerDocumentPixels(layer, ..., area)`'s ROI-cropped result (docs/master-plan.md
    // §37.3 item 2) — indexed from `area`'s own origin, not the document's, unlike `maskPixels` below.
    const sourceIndex = ((documentY - sourceOriginY) * sourceWidth + (documentX - sourceOriginX)) * 4;
    const alpha = renderedLayer[sourceIndex + 3]! / 255;
    if (!alpha) continue;
    const documentIndex = documentY * stateWidth + documentX;
    const maskAlpha = maskPixels ? maskPixels[documentIndex]! / 255 * maskDensity : 1;
    const baseAlpha = clippingBase ? clippingBase[row * width + column]! / 255 : layer.clipping ? 0 : 1;
    const coverage = alpha * maskAlpha * baseAlpha * layerAlpha;
    if (!coverage) continue;
    let lightness = (renderedLayer[sourceIndex]! * .2126 + renderedLayer[sourceIndex + 1]! * .7152 + renderedLayer[sourceIndex + 2]! * .0722) / 255;
    if (glass.invertLuminance) lightness = 1 - lightness;
    const strength = clamp01(lightness) * coverage;
    if (!strength) continue;
    const index = (row * width + column) * 4;
    // Linear interpolation between adjacent pyramid levels avoids brightness
    // bands while retaining O(1) lookup work per output pixel.
    const scaled = lightness * 3;
    const first = scaled < 1 ? output : scaled < 2 ? low : middle;
    const second = scaled < 1 ? low : scaled < 2 ? middle : high;
    const fraction = scaled < 1 ? scaled : scaled < 2 ? scaled - 1 : Math.min(1, scaled - 2);
    for (let channel = 0; channel < 3; channel += 1) {
      const blurred = first[index + channel]! + (second[index + channel]! - first[index + channel]!) * fraction;
      output[index + channel] = Math.round(output[index + channel]! + (blurred - output[index + channel]!) * strength);
    }
  }
}

/**
 * Above this many pixels a region is composited in pieces instead of in one go.
 *
 * Skipping a layer that has no content in the region is what keeps a document
 * with dozens of layers affordable, and a layer only misses a small region.
 * Asked for the whole canvas at once, nothing can be skipped and every layer is
 * walked in full: on a forty-six layer document the same pixels cost 428 ms as
 * one region and 38 ms as forty tiles. Subdividing here means every caller gets
 * the tiled cost, not just the ones that happen to ask tile by tile.
 */
const subdivideAbove = 512 * 512;
const subdivisionSize = 256;

/**
 * Whether every layer `flattenRasterLayers(state.layers)` produces is safe for the narrow,
 * Worker-portable blend fast path (`blendSimpleLayerStack` below, docs/master-plan.md §37.3 item
 * 4): an ordinary, plain `"pixel"` layer, no mask, no clipping, no effects. One layer failing this
 * test is enough to require the full `compositeRasterRegionWithCheckpoint` for the whole stack —
 * this function does not try to blend the simple layers on the fast path and the complex ones on
 * the slow path and merge the two, which would just be `compositeRasterRegionWithCheckpoint`
 * again with extra steps. Groups, adjustment layers and Smart Objects are excluded outright rather
 * than analysed further: each has its own materialisation path (recursive composite, whole-canvas
 * read-back, transform resampling) this fast path does not attempt to replicate.
 */
export function isSimpleLayerStack(state: RasterDocumentState): boolean {
  for (const layer of flattenRasterLayers(state.layers)) {
    if (layer.kind !== "pixel") return false;
    if (!isLayerEffectivelyVisible(layer, state.layers) || effectiveLayerOpacity(layer, state.layers) <= 0) continue;
    if (layer.clipping) return false;
    if (layer.mask?.enabled) return false;
    if (hasEnabledEffect(layer)) return false;
  }
  return true;
}

/** One already-materialised, document-space, ROI-cropped layer for `blendSimpleLayerStack` — the
 *  exact shape a caller gets from `layerDocumentPixels(layer, state.width, state.height, area)`
 *  plus the two scalars the blend loop needs read off the layer itself. */
export interface SimpleBlendLayer {
  readonly pixels: Uint8ClampedArray;
  /** Effective opacity × fill opacity, already resolved — this function does no layer-tree lookups. */
  readonly opacity: number;
  readonly blendMode: string;
}

/**
 * The narrow, Worker-portable half of `compositeRasterRegionWithCheckpoint`'s own per-pixel blend
 * loop, for exactly the case `isSimpleLayerStack` confirms — reusing the same `blendChannel`/
 * `blendNonSeparable`/`dissolveNoise`/`blendCode` helpers this file already defines, not a second
 * copy of the blend math. What it deliberately leaves out (masks, clipping, glass, adjustments,
 * groups) is exactly what `isSimpleLayerStack` already ruled out for any caller of this function.
 * `documentX`/`documentY` are `area`'s own top-left in document space — the only thing every layer
 * here still needs from outside its own already-cropped buffer, for `dissolveNoise`'s coordinate
 * hash to match what the full compositor would have produced for the same pixels.
 */
export function blendSimpleLayerStack(width: number, height: number, layers: readonly SimpleBlendLayer[], documentX: number, documentY: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(width * height * 4);
  const blendScratch = new Float64Array(3), sourceHsl = new Float64Array(3), destinationHsl = new Float64Array(3);
  layers.forEach((layer, layerIndex) => {
    const code = blendCode(layer.blendMode), nonSeparable = isNonSeparable(code);
    const opaqueNormal = code === NORMAL || code === DISSOLVE;
    for (let row = 0; row < height; row += 1) {
      const rowOffset = row * width;
      for (let column = 0; column < width; column += 1) {
        const index = (rowOffset + column) * 4;
        const rawAlpha = layer.pixels[index + 3]! / 255;
        let sourceAlpha = rawAlpha * layer.opacity;
        if (code === DISSOLVE) sourceAlpha = dissolveNoise(documentX + column, documentY + row, layerIndex + 1) < sourceAlpha ? 1 : 0;
        if (sourceAlpha <= 0) continue;
        const sourceRed = layer.pixels[index]!, sourceGreen = layer.pixels[index + 1]!, sourceBlue = layer.pixels[index + 2]!;
        if (opaqueNormal && sourceAlpha >= 1) {
          output[index] = sourceRed; output[index + 1] = sourceGreen; output[index + 2] = sourceBlue; output[index + 3] = 255;
          continue;
        }
        const destinationRed = output[index]!, destinationGreen = output[index + 1]!, destinationBlue = output[index + 2]!;
        let blendedRed: number, blendedGreen: number, blendedBlue: number;
        if (code === NORMAL || code === DISSOLVE) {
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
        output[index] = Math.round((blendedRed * sourceAlpha + destinationRed * carry) / alpha);
        output[index + 1] = Math.round((blendedGreen * sourceAlpha + destinationGreen * carry) / alpha);
        output[index + 2] = Math.round((blendedBlue * sourceAlpha + destinationBlue * carry) / alpha);
        output[index + 3] = Math.round(alpha * 255);
      }
    }
  });
  return output;
}

export function compositeRasterRegion(state: RasterDocumentState, region: RasterRect, options: CompositeOptions = {}): Uint8ClampedArray {
  return compositeRasterRegionWithCheckpoint(state, region, null, options).pixels;
}

/**
 * A saved boundary inside a layer stack's bottom-to-top walk (docs/master-plan.md §37.3 item 3,
 * donor GEGL's `valid_region[level]`): everything a resumed composite needs to skip the layers a
 * previous call already accounted for. `output`/`clippingBaseByParent` are exactly the two loop
 * variables in `compositeRasterRegionWithCheckpoint` that cannot be reconstructed without walking
 * the stack — `clippedParents`/`consumedByIsolatedGroup` are cheap, order-independent derivations
 * of the layer list and are simply recomputed every call, not stored here.
 *
 * A checkpoint's boundary sits exactly at whichever layer most recently turned out to have
 * changed — not "the active layer" (which breaks down inside nested isolated groups and clipping
 * stacks — see the plan's own findings) and not always "everything" either: a checkpoint only
 * ever has a snapshot *at its own recorded boundary*, nothing in between, so a layer that changed
 * anywhere *before* that boundary makes the whole snapshot unusable as a resume point for this
 * call (the walk below has to start over at 0) even though it is still exactly the right boundary
 * to hand back for the *next* call, once this one captures a fresh snapshot there. Repeatedly
 * editing the same layer is therefore the case this actually speeds up: the first such edit after
 * any other change pays for one full walk and relocates the boundary; every edit after that to the
 * same layer resumes from it directly.
 */
export interface RasterRenderCheckpoint {
  readonly signatures: readonly LayerRenderSignature[];
  readonly output: Uint8ClampedArray;
  readonly clippingBaseByParent: ReadonlyMap<string, Uint8ClampedArray>;
  /** One entry per isolated group reached so far, keyed by that group's own layer id — each
   *  group's recursive composite keeps its own checkpoint, at its own recursion level, the same
   *  mechanism applied one level down. Untouched groups' entries simply ride along unread until
   *  the outer walk reaches them again. */
  readonly groupCheckpoints: ReadonlyMap<string, RasterRenderCheckpoint>;
}

export interface RasterCompositeResult {
  readonly pixels: Uint8ClampedArray;
  readonly checkpoint: RasterRenderCheckpoint | null;
}

/** `signatures[index]` matches `checkpoint.signatures[index]` exactly, including identity — the
 *  same two-part check `changedRenderRegion` already makes (id, then everything else), just at
 *  a single index rather than over a whole array. */
const sameSignatureAndId = (a: LayerRenderSignature, b: LayerRenderSignature): boolean => a.id === b.id && sameSignature(a, b);

/**
 * The checkpoint-aware core. `compositeRasterRegion` above is the public, checkpoint-less entry
 * point every existing caller keeps using unchanged; `RasterTileCache` is the one caller that
 * keeps a checkpoint across calls and passes it back in, letting a request for the same tile skip
 * straight past every layer a checkpoint already accounted for.
 *
 * A checkpoint only ever helps here: Glass padding, step>1 (reduced/thumbnail) previews and
 * `compositeInPieces`'s own per-piece subdivision all recurse through the plain, checkpoint-less
 * `compositeRasterRegion` (a `null` checkpoint on those paths) — narrower than "every path
 * benefits," but exactly the common, highest-frequency case a live brush stroke or a slider drag
 * actually hits: one un-padded, un-subdivided, full-resolution tile request.
 */
export function compositeRasterRegionWithCheckpoint(
  state: RasterDocumentState,
  region: RasterRect,
  checkpoint: RasterRenderCheckpoint | null,
  options: CompositeOptions = {},
): RasterCompositeResult {
  const { width } = state;
  const area = clampRegionToDocument(state, region);
  const step = Math.max(1, Math.floor(options.step ?? 1));

  // A blur samples beyond the requested tile. Render a padded piece once and
  // return its centre so independently refreshed tiles cannot show seams.
  const padding = options.backdropContext ? 0 : glassPadding(state);
  // A reduced compositing pass samples every Nth source pixel. Running a blur
  // over that sparse buffer would incorrectly multiply its visible radius by
  // N, so preview/thumbnail paths use the exact full-resolution result then
  // sample it — the same representation as a normal reduced composite.
  if (padding && step > 1 && area.width && area.height) {
    return { pixels: boxDownsample(compositeRasterRegion(state, area), area.width, area.height, step), checkpoint: null };
  }
  // Zoomed out, one sample per `step` pixels was all a tile got: a one-pixel line fell between
  // samples and vanished, or survived as broken dashes, and fine patterns turned to moiré — the
  // distortion the owner saw when zooming out. The donors average instead (see `boxDownsample`).
  // Averaging the full-resolution composite would give back the whole saving the mip exists for,
  // so this composites one level finer — four samples per output pixel, a quarter of the cost of
  // full resolution at the first level and less below it — and averages that. An odd step has no
  // integer half, and averages full resolution.
  if (step === 2 && !options.pointSample && area.width > 1 && area.height > 1) {
    // The first level is the working zoom of large documents (25–50 %), and a true 2×2 average
    // there *is* a full-resolution composite — measured 1.5 s against 0.3 s on a ten-layer
    // 2000×2000 document. Two samples on the diagonal of each block (a quincunx) cost about twice
    // one sample and are enough that a one-pixel line no longer falls wholly between samples.
    const outWidth = Math.ceil(area.width / 2), outHeight = Math.ceil(area.height / 2);
    const first = compositeRasterRegionWithCheckpoint(state, area, checkpoint, { ...options, pointSample: true });
    const diagonalArea = { x: area.x + 1, y: area.y + 1, width: area.width - 1, height: area.height - 1 };
    const second = compositeRasterRegion(state, diagonalArea, { ...options, pointSample: true });
    const secondWidth = Math.ceil(diagonalArea.width / 2), secondHeight = Math.ceil(diagonalArea.height / 2);
    const pixels = first.pixels;
    for (let row = 0; row < Math.min(outHeight, secondHeight); row += 1) for (let column = 0; column < Math.min(outWidth, secondWidth); column += 1) {
      const target = (row * outWidth + column) * 4, other = (row * secondWidth + column) * 4;
      const a = pixels[target + 3]!, b = second[other + 3]!, alpha = a + b;
      if (alpha > 0) {
        pixels[target] = (pixels[target]! * a + second[other]! * b) / alpha;
        pixels[target + 1] = (pixels[target + 1]! * a + second[other + 1]! * b) / alpha;
        pixels[target + 2] = (pixels[target + 2]! * a + second[other + 2]! * b) / alpha;
      }
      pixels[target + 3] = alpha / 2;
    }
    return { pixels, checkpoint: first.checkpoint };
  }
  if (step > 1 && !options.pointSample && area.width && area.height) {
    // Beyond the first level: four samples per pixel, and from step 8 on sixteen — measured on the
    // same ten-layer document at under half and about a tenth of a full-resolution composite.
    const fine = step % 2 !== 0 ? 1 : step >= 8 && step % 4 === 0 ? step / 4 : step / 2;
    const finer = compositeRasterRegionWithCheckpoint(state, area, checkpoint, { ...options, step: fine, pointSample: true });
    const fineWidth = Math.ceil(area.width / fine), fineHeight = Math.ceil(area.height / fine);
    return { pixels: boxDownsample(finer.pixels, fineWidth, fineHeight, step / fine), checkpoint: finer.checkpoint };
  }
  if (padding && step === 1 && area.width && area.height) {
    const expanded = clampRegionToDocument(state, { x: area.x - padding, y: area.y - padding, width: area.width + padding * 2, height: area.height + padding * 2 });
    return { pixels: cropComposite(compositeRasterRegion(state, expanded, { ...options, backdropContext: true }), expanded, area), checkpoint: null };
  }

  if (step === 1 && area.width * area.height > subdivideAbove && state.layers.length > 1) {
    return { pixels: compositeInPieces(state, area), checkpoint: null };
  }
  const outWidth = Math.ceil(area.width / step), outHeight = Math.ceil(area.height / step);
  if (!area.width || !area.height) return { pixels: new Uint8ClampedArray(outWidth * outHeight * 4), checkpoint: null };
  // Allocated once per composite rather than per pixel; see blendNonSeparable.
  const blendScratch = new Float64Array(3), sourceHsl = new Float64Array(3), destinationHsl = new Float64Array(3);
  const layers = [...flattenRasterLayers(state.layers)];
  const signatures = layers.map(signatureOf);
  // A layer only has to record its own coverage when something above it clips
  // to it. Recording it unconditionally costs a buffer and a write per pixel
  // per layer, which most documents never read back.
  const clippedParents = new Set<string>();
  for (const layer of layers) if (layer.clipping) clippedParents.add(layer.parentId ?? "root");
  // Derived from the whole layer list up front, not accumulated during the loop below: a resumed
  // composite may start past an isolated group's own index, and this set has to already be
  // correct for every group at or before the resume point, or its descendants — still present as
  // separate entries in `layers` — would be walked a second time as if they were top-level layers.
  const consumedByIsolatedGroup = new Set<string>();
  for (const candidate of layers) {
    if (candidate.kind === "group" && candidate.groupMode === "isolated" && isLayerEffectivelyVisible(candidate, state.layers) && effectiveLayerOpacity(candidate, state.layers) > 0) {
      for (const id of rasterLayerDescendantIds(state.layers, candidate.id)) consumedByIsolatedGroup.add(id);
    }
  }

  // Where the incoming checkpoint's own recorded prefix first disagrees with the current layers —
  // `checkpoint.signatures.length` itself when every one of them still matches (the checkpoint's
  // own boundary was already exactly right, or every layer it names is simply unchanged and there
  // happen to be more layers now than it recorded). A checkpoint's `output`/`clippingBaseByParent`
  // are a snapshot of "everything up to its own boundary" and nothing in between — so a mismatch
  // found *before* that boundary makes the whole snapshot unusable as a resume point (there is no
  // saved state at that earlier position to resume from), not just "everything past it": the walk
  // below still has to start at 0 in that case. What survives is knowing *where* the mismatch is,
  // which becomes the new checkpoint's own boundary once this walk captures a fresh snapshot there.
  let divergedAt: number | null = null;
  let resumed = false;
  let resumeIndex = 0;
  let output = new Uint8ClampedArray(outWidth * outHeight * 4);
  let clippingBaseByParent = new Map<string, Uint8ClampedArray>();
  let groupCheckpoints = new Map<string, RasterRenderCheckpoint>();
  if (checkpoint && checkpoint.output.length === output.length && checkpoint.signatures.length <= signatures.length) {
    divergedAt = checkpoint.signatures.length;
    for (let index = 0; index < checkpoint.signatures.length; index += 1) {
      if (!sameSignatureAndId(checkpoint.signatures[index]!, signatures[index]!)) { divergedAt = index; break; }
    }
    if (divergedAt === checkpoint.signatures.length) {
      // The checkpoint's own boundary is still exactly right: resume from it as-is, and the new
      // checkpoint this call saves is simply the same one, unmodified — see the save below.
      resumed = true;
      resumeIndex = divergedAt;
      output = checkpoint.output.slice();
      clippingBaseByParent = new Map(checkpoint.clippingBaseByParent);
      groupCheckpoints = new Map(checkpoint.groupCheckpoints);
    }
  }
  // A snapshot of (signatures, output, clippingBaseByParent, groupCheckpoints) at `divergedAt` —
  // exactly what the next call's own checkpoint should be. When the resume above succeeded, this
  // is just the incoming checkpoint again (already the right boundary). When it did not, this walk
  // has to capture it itself, the moment it reaches `divergedAt` fresh — captured further down,
  // right before that layer is processed, from the *unmutated* variables (not the ones the rest of
  // this walk keeps writing into). `resumed` (not a coincidental `resumeIndex === divergedAt`,
  // which also holds — for an unrelated reason — whenever the very first layer is what changed)
  // is what actually distinguishes the two cases.
  let boundarySnapshot: RasterRenderCheckpoint | null = resumed && checkpoint ? checkpoint : null;

  for (let layerIndex = resumeIndex; layerIndex < layers.length; layerIndex += 1) {
    if (layerIndex === divergedAt && !boundarySnapshot) {
      boundarySnapshot = {
        signatures: signatures.slice(0, divergedAt),
        output: output.slice(),
        clippingBaseByParent: new Map(clippingBaseByParent),
        groupCheckpoints: new Map(groupCheckpoints),
      };
    }
    const layer = layers[layerIndex]!;
    if (consumedByIsolatedGroup.has(layer.id)) continue;
    const parentKey = layer.parentId ?? "root";
    const effectiveOpacity = effectiveLayerOpacity(layer, state.layers);
    if (layer.kind === "group" && layer.groupMode === "isolated" && isLayerEffectivelyVisible(layer, state.layers) && effectiveOpacity > 0) {
      const descendantIds = rasterLayerDescendantIds(state.layers, layer.id);
      // Render the group's descendants against transparent black in their own
      // stack. The immediate children become roots; nested groups preserve
      // their relationships and therefore recurse naturally.
      const inside = new Set(descendantIds);
      const groupState: RasterDocumentState = {
        ...state,
        layers: state.layers.filter((candidate) => inside.has(candidate.id)).map((candidate) =>
          candidate.parentId === layer.id ? { ...candidate, parentId: null } : candidate),
      };
      // A group effect (Drop Shadow, Outer/Inner Glow, Bevel) needs to read past this tile's own
      // edge exactly the way an ordinary layer's does (`requiredSourceRegion`'s own doc comment) —
      // but unlike an ordinary layer, a group has no persistent document-sized buffer to read a
      // halo from at all: its "pixels" only exist as far as they were just composited, right here.
      // Compositing the descendants for `area` alone and only *afterward* asking whether the group
      // effect needed more than that (the bug: `renderLayerEffects` was called with no `region`, so
      // its own halo logic never even ran) leaves genuine transparent black past the tile boundary
      // — a real edge, not a sampled one — which an Outer Glow/Drop Shadow near a tile seam then
      // renders as a visible seam or hard clip exactly at that boundary. The fix is the same shape
      // as `glassPadding`'s own expand-then-crop a few dozen lines up in this same function, scoped
      // to just this one group instead of the whole composite: ask `requiredSourceRegion` (the exact
      // function an ordinary layer's own effects already use) how far the group's *own* effects
      // reach, composite the descendants over that wider area, and let `renderLayerEffects`'s
      // `region` argument crop the result back down to this tile once the effect has real neighbour
      // pixels to read. Only pays for the wider composite when this specific group actually has an
      // enabled effect — the overwhelmingly common case (no group-level style at all) is untouched.
      const groupNeedsEffectHalo = hasRenderableEffect(layer);
      const groupSourceArea = groupNeedsEffectHalo ? requiredSourceRegion(layer, area, state.width, state.height) : area;
      const groupResult = compositeRasterRegionWithCheckpoint(groupState, groupSourceArea, groupNeedsEffectHalo ? null : (groupCheckpoints.get(layer.id) ?? null), options);
      // A checkpoint is keyed to `area`'s own boundary; once padded to `groupSourceArea` it would
      // resume into the wrong rectangle on the next call, so a haloed group simply does not use
      // one (`null` above) or save one (skipped below) — correctness over the checkpoint's own
      // resume optimisation for the one case (a group with an enabled effect) that needs the halo.
      if (!groupNeedsEffectHalo) { if (groupResult.checkpoint) groupCheckpoints.set(layer.id, groupResult.checkpoint); else groupCheckpoints.delete(layer.id); }
      const rawGroupPixels = groupResult.pixels;
      const groupSourceWidth = Math.ceil(groupSourceArea.width / step), groupSourceHeight = Math.ceil(groupSourceArea.height / step);
      // Reuse the layer-style renderer on the subtree's already-composited
      // surface. A group effect belongs outside its children, unlike effects
      // on each child, so this is intentionally after the recursive pass.
      // Skipped entirely when the group has no effect of its own (by far the common case): the
      // `TileStore.fromPixels`/its later `.toPixels()` round-trip is pure overhead when nothing is
      // about to read the wrapper back out through `renderLayerEffects` in the first place.
      let groupPixels = rawGroupPixels;
      if (groupNeedsEffectHalo) {
        // `TileStore.fromPixels`/its later `.toPixels()` round-trip is pure overhead here —
        // `rawGroupPixels` is already exactly the flat buffer `renderLayerEffects` will read back
        // out — but this synthetic wrapper is a fresh object every call regardless (no caching ever
        // applied to it, tiled or flat), and an isolated group with its own enabled layer style is
        // rare enough that a real API change to let `renderLayerEffects` take a bare buffer directly
        // isn't worth it for this one call site.
        const groupSurfaceLayer: RasterLayer = {
          ...layer, kind: "pixel", parentId: null, tiles: TileStore.fromPixels(rawGroupPixels, groupSourceWidth, groupSourceHeight),
          bounds: { x: 0, y: 0, width: groupSourceWidth, height: groupSourceHeight }, width: groupSourceWidth, height: groupSourceHeight,
        };
        // Where this tile's own `outWidth`×`outHeight` output actually sits inside the wider
        // `groupSourceArea` surface just built.
        const groupOutputRegion: RasterRect = {
          x: Math.round((area.x - groupSourceArea.x) / step), y: Math.round((area.y - groupSourceArea.y) / step), width: outWidth, height: outHeight,
        };
        groupPixels = renderLayerEffects(groupSurfaceLayer, groupSourceWidth, groupSourceHeight, groupOutputRegion);
      }
      const groupMask = layer.mask?.enabled ? featherMask(layer.mask, state.width, state.height, layer.mask.feather) : undefined;
      const groupCode = blendCode(layer.blendMode), groupNonSeparable = isNonSeparable(groupCode);
      const groupClippingBase = layer.clipping ? clippingBaseByParent.get(parentKey) : undefined;
      const groupOwnAlpha = layer.clipping || !clippedParents.has(parentKey) ? null : new Uint8ClampedArray(outWidth * outHeight);
      for (let row = 0; row < outHeight; row += 1) for (let column = 0; column < outWidth; column += 1) {
        const index = (row * outWidth + column) * 4;
        const maskAlpha = groupMask ? groupMask[(area.y + row * step) * state.width + area.x + column * step]! / 255 * (layer.mask?.density ?? 1) : 1;
        const rawAlpha = groupPixels[index + 3]! / 255 * maskAlpha;
        if (groupOwnAlpha) groupOwnAlpha[index] = Math.round(rawAlpha * 255);
        const sourceAlpha = rawAlpha * effectiveOpacity * (groupClippingBase ? groupClippingBase[index]! / 255 : layer.clipping ? 0 : 1);
        if (sourceAlpha <= 0) continue;
        const destinationAlpha = output[index + 3]! / 255;
        const carry = destinationAlpha * (1 - sourceAlpha), alpha = sourceAlpha + carry;
        const sourceRed = groupPixels[index]!, sourceGreen = groupPixels[index + 1]!, sourceBlue = groupPixels[index + 2]!;
        const destinationRed = output[index]!, destinationGreen = output[index + 1]!, destinationBlue = output[index + 2]!;
        let blendedRed = sourceRed, blendedGreen = sourceGreen, blendedBlue = sourceBlue;
        if (groupNonSeparable) {
          blendNonSeparable(groupCode, sourceRed, sourceGreen, sourceBlue, destinationRed, destinationGreen, destinationBlue, blendScratch, sourceHsl, destinationHsl);
          blendedRed = blendScratch[0]!; blendedGreen = blendScratch[1]!; blendedBlue = blendScratch[2]!;
        } else if (groupCode !== NORMAL && groupCode !== DISSOLVE) {
          blendedRed = blendChannel(groupCode, sourceRed, destinationRed);
          blendedGreen = blendChannel(groupCode, sourceGreen, destinationGreen);
          blendedBlue = blendChannel(groupCode, sourceBlue, destinationBlue);
        }
        output[index] = Math.round((blendedRed * sourceAlpha + destinationRed * carry) / alpha);
        output[index + 1] = Math.round((blendedGreen * sourceAlpha + destinationGreen * carry) / alpha);
        output[index + 2] = Math.round((blendedBlue * sourceAlpha + destinationBlue * carry) / alpha);
        output[index + 3] = Math.round(alpha * 255);
      }
      if (groupOwnAlpha) clippingBaseByParent.set(parentKey, groupOwnAlpha);
      continue;
    }
    if (layer.kind === "group" || !isLayerEffectivelyVisible(layer, state.layers) || effectiveOpacity <= 0) {
      if (layer.kind !== "group" && !layer.clipping) clippingBaseByParent.delete(parentKey);
      continue;
    }
    if (layer.kind === "adjustment" && layer.adjustment) {
      const clippingBase = layer.clipping ? clippingBaseByParent.get(parentKey) : undefined;
      const maskPixels = layer.mask?.enabled ? featherMask(layer.mask, state.width, state.height, layer.mask.feather) : null;
      const before = maskPixels || clippingBase ? output.slice() : null;
      applyAdjustment(output, layer.adjustment, effectiveOpacity);
      if (before) for (let row = 0; row < outHeight; row += 1) for (let column = 0; column < outWidth; column += 1) {
        const index = (row * outWidth + column) * 4, documentIndex = (area.y + row * step) * width + (area.x + column * step);
        const sample = maskPixels ? maskPixels[documentIndex]! : 255;
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
    // Rows and columns of the region this layer can actually reach. A layer that
    // covers a tenth of a tile was still being walked over the whole of it; the
    // rest of the region is transparent for this layer and contributes nothing.
    // A layer only covers its own rectangle, so that is all the region worth
    // walking. Effects paint outside it and adjustments read everything beneath,
    // so those two keep the whole region and a canvas-sized surface.
    const effectsOn = hasEnabledEffect(layer);
    const wholeCanvas = layer.kind === "adjustment" || Boolean(layer.adjustment) || effectsOn;
    let firstRow = 0, lastRow = outHeight - 1, firstColumn = 0, lastColumn = outWidth - 1;
    if (!wholeCanvas) {
      if (!layer.bounds) throw new Error(`Layer ${layer.id} has no bounds; the document was not migrated`);
      if (!overlaps(layer.bounds, area)) continue;
      firstRow = Math.max(0, Math.floor((layer.bounds.y - area.y) / step));
      lastRow = Math.min(outHeight - 1, Math.ceil((layer.bounds.y + layer.bounds.height - area.y) / step));
      firstColumn = Math.max(0, Math.floor((layer.bounds.x - area.x) / step));
      lastColumn = Math.min(outWidth - 1, Math.ceil((layer.bounds.x + layer.bounds.width - area.x) / step));
      if (firstRow > lastRow || firstColumn > lastColumn) continue;
    }

    // Ordinary layers are read where they live; the two exceptions above are
    // laid out across the canvas first, since that is the space they work in.
    // A Smart Object is a third case: its compact buffer remains its pristine
    // source, while its placement is materialised only for this composite.
    const smartSurface = layer.kind === "smart" && Boolean(layer.smartTransform);
    const documentSurface = wholeCanvas || smartSurface;
    // Both branches ask for exactly `area`, not the whole document (docs/master-plan.md §37.3
    // item 2) — the blend loop below only ever reads within `area` anyway, so a cache miss no
    // longer pays for the rest of the document just to answer this one piece/tile's request.
    const renderedLayer = wholeCanvas
      ? (hasRenderableEffect(layer) ? renderLayerEffects(layer, state.width, state.height, area) : layerDocumentPixels(layer, state.width, state.height, area))
      : smartSurface ? layerDocumentPixels(layer, state.width, state.height, area) : layerPixelsView(layer);
    const sourceWidth = documentSurface ? area.width : layer.bounds.width;
    const sourceHeight = documentSurface ? area.height : layer.bounds.height;
    const sourceOriginX = documentSurface ? area.x : layer.bounds.x;
    const sourceOriginY = documentSurface ? area.y : layer.bounds.y;
    const clippingBase = layer.clipping ? clippingBaseByParent.get(parentKey) : undefined;
    const ownAlpha = layer.clipping || !clippedParents.has(parentKey) ? null : new Uint8ClampedArray(outWidth * outHeight);
    // Everything constant for the layer is read once. Inside the loop these are
    // touched a few million times, and a property lookup there is not free.
    const code = blendCode(layer.blendMode);
    const nonSeparable = isNonSeparable(code);
    const mask = layer.mask?.enabled ? layer.mask : null;
    const maskPixels = mask ? featherMask(mask, state.width, state.height, mask.feather) : undefined, maskDensity = mask?.density ?? 1;
    const layerAlpha = effectiveOpacity * (layer.fillOpacity ?? 1);
    const clipping = layer.clipping === true;
    const glass = layer.effects?.glass?.enabled ? layer.effects.glass : null;
    if (glass) applyGlassBackdrop(output, outWidth, outHeight, layer, renderedLayer, area, state.width, sourceWidth, sourceOriginX, sourceOriginY, step, maskPixels, maskDensity, clippingBase, layerAlpha);
    const opaqueNormal = (code === NORMAL || code === DISSOLVE) && !clipping && !glass;

    for (let row = firstRow; row <= lastRow; row += 1) {
      const documentRow = (area.y + row * step) * width + area.x;
      const outputRow = row * outWidth;
      const documentY = area.y + row * step;
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const regionIndex = outputRow + column, index = regionIndex * 4;
        const documentIndex = documentRow + column * step;
        const sourceX = area.x + column * step - sourceOriginX, sourceY = documentY - sourceOriginY;
        if (sourceX < 0 || sourceY < 0 || sourceX >= sourceWidth || sourceY >= sourceHeight) continue;
        const sourceIndex = (sourceY * sourceWidth + sourceX) * 4;
        const maskAlpha = maskPixels ? (maskPixels[documentIndex]! / 255) * maskDensity : 1;
        const baseAlpha = clippingBase ? clippingBase[regionIndex]! / 255 : clipping ? 0 : 1;
        const rawAlpha = (renderedLayer[sourceIndex + 3]! / 255) * maskAlpha;
        if (ownAlpha) ownAlpha[regionIndex] = Math.round(rawAlpha * 255);
        let sourceAlpha = rawAlpha * baseAlpha * layerAlpha;
        // The backdrop was already frosted above. The painted pixels are only
        // the pane's tint, so an opaque white source never hides its own blur.
        if (glass) sourceAlpha *= clamp01(glass.tintOpacity);
        // Dissolve makes a pixel fully present or absent instead of blending
        // it semi-transparently. The coordinate hash keeps tiles and exports
        // byte-identical without mutable RNG state.
        if (code === DISSOLVE) sourceAlpha = dissolveNoise(area.x + column * step, documentY, layerIndex + 1) < sourceAlpha ? 1 : 0;
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
        if (code === NORMAL || code === DISSOLVE) {
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
  // No checkpoint was passed in at all: there is no earlier-run signal for where a future edit is
  // likely to land, so the only sound default is "everything" — the very next call, if anything
  // changed, discovers the real boundary itself and narrows to it from there.
  return { pixels: output, checkpoint: boundarySnapshot ?? { signatures, output, clippingBaseByParent, groupCheckpoints } };
}

/**
 * Composites a large area as a grid of small ones and stitches the result.
 *
 * Each piece is composited independently, which the tile cache already relies
 * on: a region's pixels never depend on what surrounds it. So this is the same
 * picture, assembled from cheaper parts.
 */
function compositeInPieces(state: RasterDocumentState, area: RasterRect): Uint8ClampedArray {
  const output = new Uint8ClampedArray(area.width * area.height * 4);
  for (let top = 0; top < area.height; top += subdivisionSize) {
    const height = Math.min(subdivisionSize, area.height - top);
    for (let left = 0; left < area.width; left += subdivisionSize) {
      const pieceWidth = Math.min(subdivisionSize, area.width - left);
      const piece = compositeRasterRegion(state, { x: area.x + left, y: area.y + top, width: pieceWidth, height });
      for (let row = 0; row < height; row += 1) {
        output.set(piece.subarray(row * pieceWidth * 4, (row + 1) * pieceWidth * 4), ((top + row) * area.width + left) * 4);
      }
    }
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

/**
 * What a layer contributes to the picture, as one comparable value.
 *
 * Borrowed from Patchy, which keeps a render revision per layer and diffs two
 * of these lists to work out how much of the canvas an undo has to repaint. The
 * same question comes up on every document change here: today anything that
 * does not report a dirty region — a changed opacity, a hidden layer, a
 * reorder, an undo — is treated as "everything changed" and recomposites the
 * whole document. Comparing signatures says which layers actually differ.
 *
 * Buffer identity stands in for their revision counter, which works because
 * every path that edits pixels assigns a fresh buffer rather than writing
 * through the old one.
 */
export interface LayerRenderSignature {
  readonly id: string;
  readonly kind: RasterLayer["kind"];
  /** `RasterLayer.pixelsRevision` at the moment this signature was taken — `sameSignature` compares this, not `pixels` below, so two signatures pointing at the very same (in-place-mutated) buffer still compare unequal when the content actually changed (docs/master-plan.md §37.6.2). */
  readonly pixelsRevision: number;
  /**
   * Kept for `signatureRegion`'s one-time read of a *changed* layer's actual opaque bounds — never
   * used for comparison, `pixelsRevision` above owns that. A thunk over the `TileStore` reference
   * captured at signature time (see `signatureOf`'s own comment on why that capture can't be
   * deferred too), not the materialised buffer itself: a signature is taken for *every* layer on
   * *every* render (`layerRenderSignatures` below), most of which `sameSignature` will find
   * unchanged and `signatureRegion` will therefore never call this for — eagerly materialising here
   * paid for a full `toPixels()` on every single layer every render regardless, and, found live,
   * crashed outright the moment any layer was evicted (docs/master-plan.md §37.3 item 6): a hidden,
   * evicted layer's `pixelsRevision` never changes while it stays evicted, so `sameSignature` always
   * finds it unchanged and this thunk is simply never invoked for it — the fix that makes eviction
   * invisible to this file at all, not a special-cased check for it.
   */
  readonly pixels: () => Uint8ClampedArray;
  /**
   * Where that buffer lives, and the geometry it has to be read with.
   *
   * A layer keeps its pixels trimmed to its own content (`setLayerPixels`), so
   * the buffer is `bounds.width * bounds.height`, not canvas-sized — reading it
   * with the canvas's dimensions walks off the end of it.
   */
  readonly bounds: RasterRect;
  /** `null` when the layer has no mask; its `pixelsRevision` otherwise — the same replacement as `pixelsRevision` above, for the same reason. */
  readonly maskPixelsRevision: number | null;
  readonly maskEnabled: boolean;
  /** Mask settings alter composite coverage even when its byte buffer stays put. */
  readonly maskDensity: number;
  readonly maskFeather: number;
  readonly visible: boolean;
  readonly opacity: number;
  readonly fillOpacity: number;
  readonly blendMode: string;
  readonly clipping: boolean;
  readonly effects: unknown;
  readonly adjustment: unknown;
  readonly parentId: string | null;
  readonly orderKey: string;
  readonly smartTransform: unknown;
}

/** One layer's own comparable snapshot — shared by `layerRenderSignatures` (a fresh scan over
 *  the whole document) and `compositeRasterRegionWithCheckpoint` (mapped once over a `layers`
 *  array it already has), so the field list lives in exactly one place. */
function signatureOf(layer: RasterLayer): LayerRenderSignature {
  // Captured now, read later: layers are mutated in place (a commit reassigns `layer.tiles` to a
  // fresh `TileStore` rather than replacing the layer object itself), so a thunk that closed over
  // `layer` and called `layerPixelsView(layer)` at invocation time would silently read whatever
  // `layer.tiles` has become by then — the *next* edit's content, not this signature's own moment —
  // for any layer mutated in place between two signatures being compared. Capturing the `TileStore`
  // reference itself costs nothing (a `TileStore` clone is O(tile count) at most; this doesn't even
  // clone), and defers only the genuinely expensive part, `.toPixels()`, to a call that in practice
  // only ever happens for a layer `sameSignature` already found changed.
  const tiles = layer.tiles;
  return {
    id: layer.id,
    kind: layer.kind,
    pixelsRevision: layer.pixelsRevision,
    pixels: () => tiles.toPixels(),
    bounds: layer.bounds,
    maskPixelsRevision: layer.mask?.pixelsRevision ?? null,
    maskEnabled: layer.mask?.enabled ?? false,
    maskDensity: layer.mask?.density ?? 1,
    maskFeather: layer.mask?.feather ?? 0,
    visible: layer.visible,
    opacity: layer.opacity,
    fillOpacity: layer.fillOpacity ?? 1,
    blendMode: layer.blendMode,
    clipping: layer.clipping === true,
    effects: layer.effects,
    adjustment: layer.adjustment,
    parentId: layer.parentId,
    orderKey: layer.orderKey,
    smartTransform: layer.smartTransform,
  };
}

export function layerRenderSignatures(state: RasterDocumentState): LayerRenderSignature[] {
  return flattenRasterLayers(state.layers).map(signatureOf);
}

const sameTransform = (a: unknown, b: unknown): boolean => {
  const left = a as { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number } | undefined;
  const right = b as typeof left;
  return left === right || Boolean(left && right && left.a === right.a && left.b === right.b && left.c === right.c && left.d === right.d && left.e === right.e && left.f === right.f);
};

const sameSignature = (a: LayerRenderSignature, b: LayerRenderSignature): boolean =>
  a.kind === b.kind && a.pixelsRevision === b.pixelsRevision && a.maskPixelsRevision === b.maskPixelsRevision && a.maskEnabled === b.maskEnabled
  && a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y && a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height
  && a.maskDensity === b.maskDensity && a.maskFeather === b.maskFeather
  && a.visible === b.visible && a.opacity === b.opacity && a.fillOpacity === b.fillOpacity
  && a.blendMode === b.blendMode && a.clipping === b.clipping
  && a.effects === b.effects && a.adjustment === b.adjustment
  && a.parentId === b.parentId && a.orderKey === b.orderKey
  && sameTransform(a.smartTransform, b.smartTransform);

/**
 * Where a signature's opaque content actually is, in document coordinates.
 *
 * Read with the layer's own geometry and then offset, not with the canvas's:
 * a trimmed buffer read at canvas size runs past its end, and an out-of-range
 * read on a typed array is `undefined`, which the alpha test counts as opaque.
 * That silently turned every ordinary stroke's region into the whole document —
 * safe, since repainting too much only costs time, and therefore invisible: the
 * tile cache simply stopped paying off for exactly the case it exists for.
 */
function signatureRegion(signature: LayerRenderSignature): RasterRect | null {
  let pixels: Uint8ClampedArray;
  try {
    pixels = signature.pixels();
  } catch (error) {
    // Found live: a hidden, evicted layer (docs/master-plan.md §37.3 item 6) becoming visible again
    // is exactly a case `sameSignature` correctly reports as "changed" (`visible` is one of its own
    // fields) — reaching here to find out *where* it changed. Its "before" signature's `pixels()`
    // was captured while still evicted, so there is no historical buffer left to compute an exact
    // opaque sub-region from; that data was never lying around uninspected, it was actually freed.
    // The layer's own bounds are still a real, correct (if less precise — the full rectangle, not
    // just its opaque pixels within it) answer, not a reason to fall back to "unknown" and force a
    // full-document repaint the way `null` would a few lines below.
    if (error instanceof EvictedTileStoreError) return { ...signature.bounds };
    throw error;
  }
  const local = layerOpaqueBounds(pixels, signature.bounds.width, signature.bounds.height, signature.pixelsRevision);
  if (!local) return null;
  return { x: local.x + signature.bounds.x, y: local.y + signature.bounds.y, width: local.width, height: local.height };
}

/** The ink bounds of the small set of effects whose current renderer has a
 * finite, explicit extent. Returning undefined means "unknown", requiring a
 * safe full repaint rather than a guessed dirty rectangle. */
function signatureInkRegion(signature: LayerRenderSignature): RasterRect | null | undefined {
  let region = signatureRegion(signature);
  if (!region) return null;
  const effects = signature.effects;
  if (!effects || typeof effects !== "object") return region;
  const union = (other: RasterRect) => {
    const left = Math.min(region!.x, other.x), top = Math.min(region!.y, other.y);
    const right = Math.max(region!.x + region!.width, other.x + other.width), bottom = Math.max(region!.y + region!.height, other.y + other.height);
    region = { x: left, y: top, width: right - left, height: bottom - top };
  };
  for (const [name, effect] of Object.entries(effects as Record<string, unknown>)) {
    if (!effect || typeof effect !== "object" || !(effect as { enabled?: boolean }).enabled) continue;
    const values = effect as { offsetX?: number; offsetY?: number; radius?: number };
    if (name === "dropShadow") {
      union({ x: region.x + Math.round(values.offsetX ?? 0), y: region.y + Math.round(values.offsetY ?? 0), width: region.width, height: region.height });
    } else if (name === "outerGlow") {
      const radius = Math.max(0, Math.min(32, Math.ceil(values.radius ?? 0)));
      union({ x: region.x - radius, y: region.y - radius, width: region.width + radius * 2, height: region.height + radius * 2 });
    } else if (!["innerShadow", "innerGlow", "bevel", "gradientOverlay", "glass"].includes(name)) return undefined;
  }
  return region;
}

/**
 * The region that can look different between two states, or null for "all of it".
 *
 * Null is returned whenever the answer cannot be bounded honestly: the layer
 * set changed, an adjustment layer is involved (it reads back everything
 * beneath it), or a layer carries an effect (which draws outside its own
 * pixels). Guessing smaller than the truth leaves stale pixels on screen, which
 * is a worse failure than repainting too much.
 */
export function changedRenderRegion(
  before: readonly LayerRenderSignature[],
  after: readonly LayerRenderSignature[],
): RasterRect | null {
  if (before.length !== after.length) return null;
  for (let index = 0; index < before.length; index += 1) if (before[index]!.id !== after[index]!.id) return null;

  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const include = (rect: RasterRect | null) => {
    if (!rect) return;
    left = Math.min(left, rect.x); top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height);
  };

  for (let index = 0; index < before.length; index += 1) {
    const was = before[index]!, now = after[index]!;
    if (sameSignature(was, now)) continue;
    // A group has no drawable pixels of its own, yet its properties affect the
    // composite contribution of every descendant. Its empty buffer cannot be
    // an honest dirty rectangle, so take the safe full-document path until
    // RasterRenderPlan can provide descendant ink bounds directly.
    if (was.kind === "group" || now.kind === "group") return null;
    // An adjustment reads everything below it. Known effects have finite ink
    // bounds; an unfamiliar one remains deliberately conservative.
    if (was.adjustment || now.adjustment) return null;
    const wasRegion = signatureInkRegion(was), nowRegion = signatureInkRegion(now);
    if (wasRegion === undefined || nowRegion === undefined) return null;
    include(wasRegion);
    include(nowRegion);
  }

  if (right <= left || bottom <= top) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function hasEnabledEffectValue(effects: unknown): boolean {
  if (!effects || typeof effects !== "object") return false;
  return Object.values(effects as Record<string, unknown>).some(
    (effect) => typeof effect === "object" && effect !== null && (effect as { enabled?: boolean }).enabled === true,
  );
}
