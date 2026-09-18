import { adjustRgb, applyAdjustment, pointFunctions } from "./adjustments";
import { bufferDepth, depthMaximum, type PixelBuffer } from "./pixel-format";
import type { RasterAdjustment } from "./types";

/**
 * Adjustments computed at the layer's real depth (docs/master-plan.md §59.2a).
 *
 * `applyAdjustment` reduces every point adjustment to a 256-entry byte table. That is the right
 * trade at 8 bits — one cubic-spline solve instead of millions — and exactly the wrong one at 16
 * or 32, where the table's own 256 steps *are* the banding the deep document was chosen to avoid.
 * Two curves stacked on an 8-bit table leave visible steps in a sky; the whole reason to work in
 * 16-bit is that they do not.
 *
 * So the same formulas (`pointFunctions`, shared with the 8-bit path so the two cannot drift) are
 * sampled into a much finer float table and interpolated between entries — GIMP's own answer in
 * `gimp_operation_curves`, and darktable's for its tone curve: a dense LUT plus interpolation,
 * rather than either a byte table or a spline solve per pixel.
 *
 * Adjustments that are not point functions (hue/saturation, channel mixer, selective colour,
 * shadows/highlights, …) genuinely mix channels and have no table to build. They are evaluated per
 * pixel through `adjustRgb`, which works in a 0…255 domain and rounds its result to whole bytes —
 * so those keep 8-bit precision even in a deep document. Said plainly rather than hidden: it is
 * what the code does today, and `LUT_SIZE` steps of extra precision on the tonal adjustments is
 * where the benefit of a deep document actually lands.
 */

/** 4096 steps over the 0…255 domain, and linear interpolation between them: sixteen times finer
 *  than 16-bit storage can express, so the table stops being the limiting factor. */
const LUT_SIZE = 4096;

const sampleLut = (lut: Float32Array, value: number, maximum: number): number => {
  if (value <= 0) return lut[0]!;
  if (value >= maximum) return lut[LUT_SIZE - 1]!;
  const position = value / maximum * (LUT_SIZE - 1);
  const low = Math.floor(position), fraction = position - low;
  const a = lut[low]!, b = lut[Math.min(LUT_SIZE - 1, low + 1)]!;
  return a + (b - a) * fraction;
};

const buildFloatLut = (point: (value: number) => number): Float32Array => {
  const lut = new Float32Array(LUT_SIZE);
  for (let index = 0; index < LUT_SIZE; index += 1) lut[index] = point(index * 255 / (LUT_SIZE - 1));
  return lut;
};

/**
 * Applies `adjustment` in place to a buffer of any depth.
 *
 * The buffer's own values are read and written in its native range (0…255, 0…65535 or 0…1); the
 * formulas run in the 0…255 domain they were written in, and the scaling happens at the boundary —
 * the same arrangement as every other depth-aware operation here.
 *
 * Float buffers are not clamped at the top. A 32-bit document holds highlights above 1 on purpose,
 * and an exposure adjustment that pushed them there is precisely the operation that must not
 * quietly throw them away; 8- and 16-bit buffers clamp because their storage cannot do otherwise
 * (their typed arrays do it themselves).
 */
export function applyAdjustmentDeep(pixels: PixelBuffer, adjustment: RasterAdjustment, opacity = 1): void {
  const depth = bufferDepth(pixels);
  // 8 bits keeps the byte table it has always used: at that depth the table is not the limit,
  // and a second implementation of the same thing is how two answers to one question start.
  if (depth === 8) { applyAdjustment(pixels as Uint8ClampedArray, adjustment, opacity); return; }
  const maximum = depthMaximum(depth);
  const toDomain = 255 / maximum, fromDomain = maximum / 255;
  const mix = Math.max(0, Math.min(1, opacity));
  /**
   * `Uint8ClampedArray` clamps on assignment; `Uint16Array` does not — it takes the value modulo
   * 2^16, so a formula that goes negative (brightness/contrast on a dark pixel does, routinely)
   * would store *white* instead of black. Found by the test that compares the two depths on the
   * same colour: channel 0 came back 229 8-bit steps away from its 8-bit answer.
   *
   * Float keeps its range on purpose, so it clamps at neither end.
   */
  const clamp = depth === 32 ? (value: number) => value : (value: number) => Math.max(0, Math.min(maximum, value));
  const points = pointFunctions(adjustment);
  const luts = points ? [buildFloatLut(points[0]), buildFloatLut(points[1]), buildFloatLut(points[2])] as const : null;
  for (let index = 0; index < pixels.length; index += 4) {
    if (!pixels[index + 3]) continue;
    const sourceR = pixels[index]!, sourceG = pixels[index + 1]!, sourceB = pixels[index + 2]!;
    let r: number, g: number, b: number;
    if (luts) {
      r = sampleLut(luts[0], sourceR, maximum) * fromDomain;
      g = sampleLut(luts[1], sourceG, maximum) * fromDomain;
      b = sampleLut(luts[2], sourceB, maximum) * fromDomain;
    } else {
      const [outR, outG, outB] = adjustRgb(sourceR * toDomain, sourceG * toDomain, sourceB * toDomain, adjustment);
      r = outR * fromDomain; g = outG * fromDomain; b = outB * fromDomain;
    }
    const dither = adjustment.kind === "gradientMap" && adjustment.dither ? ((index / 4 * 73) % 5 - 2) * .35 * fromDomain : 0;
    pixels[index] = clamp(sourceR + (r - sourceR) * mix + dither);
    pixels[index + 1] = clamp(sourceG + (g - sourceG) * mix + dither);
    pixels[index + 2] = clamp(sourceB + (b - sourceB) * mix + dither);
  }
}

/**
 * One layer's own pixels, adjusted at its own depth, in its own local frame.
 *
 * The 8-bit path materialises a canvas-sized RGBA buffer, adjusts it and writes it back through
 * `setLayerPixels`. That round trip is lossless at 8 bits and lossy at 16 or 32 — the buffer in the
 * middle is the narrow part — so a deep layer takes this path instead: read the layer's own tiles
 * in their own format, adjust, write back. The layer's bounds cannot change (an adjustment never
 * moves alpha), so nothing needs re-trimming, and the result is exactly `rect`-shaped, which is
 * what `TileStore.writeLocalRegion` takes.
 *
 * `before` is handed back alongside `after` because that pair is what history stores: a conversion
 * is not reversible by re-running it (docs/master-plan.md §59.2).
 */
export function adjustLayerPixelsDeep(
  layer: { tiles?: { depth: number; readLocalRegionDeep(rect: { x: number; y: number; width: number; height: number }): PixelBuffer }; bounds: { x: number; y: number; width: number; height: number } },
  adjustment: RasterAdjustment,
  selection: { mask: Uint8ClampedArray; } | null,
  documentWidth: number,
  documentHeight: number,
): { rect: { x: number; y: number; width: number; height: number }; before: PixelBuffer; after: PixelBuffer } | null {
  if (!layer.tiles) return null;
  const rect = { x: 0, y: 0, width: layer.bounds.width, height: layer.bounds.height };
  const before = layer.tiles.readLocalRegionDeep(rect);
  const after = before.slice();
  applyAdjustmentDeep(after, adjustment);
  if (selection) {
    // The selection is document-space coverage; the buffer is layer-local, so the mask is read at
    // the layer's own offset. Partial coverage blends, exactly as `confineToSelection` does for
    // the 8-bit path — the same rule, at this buffer's precision.
    for (let y = 0; y < rect.height; y += 1) {
      const documentY = layer.bounds.y + y;
      for (let x = 0; x < rect.width; x += 1) {
        const documentX = layer.bounds.x + x;
        const inside = documentX >= 0 && documentY >= 0 && documentX < documentWidth && documentY < documentHeight;
        const coverage = inside ? selection.mask[documentY * documentWidth + documentX]! / 255 : 0;
        if (coverage === 1) continue;
        const index = (y * rect.width + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          after[index + channel] = before[index + channel]! + (after[index + channel]! - before[index + channel]!) * coverage;
        }
      }
    }
  }
  return { rect, before, after };
}
