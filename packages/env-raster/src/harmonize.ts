/**
 * Classic (non-neural) color/light harmonization — Reinhard's "Color Transfer
 * between Images" (2001): match a foreground's Lab mean/standard-deviation to
 * a reference's, per channel. The donor the master-plan actually names for
 * this feature, Harmonizer (ZHKKKe/Harmonizer), is CC BY-NC-SA — not
 * embeddable in a product — and its own recommended alternative, PCT-Net
 * (rakutentech/PCT-Net-Image-Harmonization, MPL-2.0, genuinely embeddable),
 * only ships PyTorch `.pth` weights with no ONNX export anywhere and no
 * Python/PyTorch toolchain in this project to produce one. Reinhard's
 * algorithm needs no trained weights at all — it is the "Fast" mode's
 * stand-in until a real ONNX model can be sourced, not a placeholder that
 * does nothing: it is the actual technique real compositing tools have used
 * for exactly this for two decades, before learned harmonization existed.
 *
 * Lab, not RGB: Reinhard's own paper works in a decorrelated space (its
 * original lαβ, here CIE Lab, the standard substitute — the point is a space
 * where the three channels can be matched independently without introducing
 * hue shifts, which shifting R/G/B means separately does not guarantee).
 */

export interface LabStats {
  readonly l: { readonly mean: number; readonly std: number };
  readonly a: { readonly mean: number; readonly std: number };
  readonly b: { readonly mean: number; readonly std: number };
}

function srgbToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const v = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, v * 255));
}

const WHITE_X = 0.95047, WHITE_Y = 1, WHITE_Z = 1.08883;
const LAB_EPSILON = 216 / 24389, LAB_KAPPA = 24389 / 27;

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / WHITE_X;
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl) / WHITE_Y;
  const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / WHITE_Z;
  const f = (t: number) => (t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const fInv = (t: number) => (t ** 3 > LAB_EPSILON ? t ** 3 : (116 * t - 16) / LAB_KAPPA);
  const x = fInv(fx) * WHITE_X, y = l > LAB_KAPPA * LAB_EPSILON ? fy ** 3 : l / LAB_KAPPA, z = fInv(fz) * WHITE_Z;
  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [linearToSrgb(rl), linearToSrgb(gl), linearToSrgb(bl)];
}

/**
 * Mean and standard deviation of L/a/b over a pixel buffer's opaque pixels
 * — the "what does this region's own lighting and color palette look like"
 * summary Reinhard's transform needs on both sides (the layer being
 * harmonized, and the scene it needs to match).
 */
export function computeLabStats(pixels: Uint8ClampedArray, width: number, height: number, region?: { x: number; y: number; width: number; height: number }): LabStats | null {
  const left = Math.max(0, region?.x ?? 0), top = Math.max(0, region?.y ?? 0);
  const right = Math.min(width, region ? region.x + region.width : width);
  const bottom = Math.min(height, region ? region.y + region.height : height);
  let count = 0, sumL = 0, sumA = 0, sumB = 0;
  const ls: number[] = [], as: number[] = [], bs: number[] = [];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * width + x) * 4;
      if (pixels[index + 3] === 0) continue;
      const [l, a, b] = rgbToLab(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!);
      ls.push(l); as.push(a); bs.push(b);
      sumL += l; sumA += a; sumB += b;
      count += 1;
    }
  }
  if (!count) return null;
  const meanL = sumL / count, meanA = sumA / count, meanB = sumB / count;
  let varL = 0, varA = 0, varB = 0;
  for (let index = 0; index < count; index += 1) {
    varL += (ls[index]! - meanL) ** 2; varA += (as[index]! - meanA) ** 2; varB += (bs[index]! - meanB) ** 2;
  }
  return {
    l: { mean: meanL, std: Math.sqrt(varL / count) },
    a: { mean: meanA, std: Math.sqrt(varA / count) },
    b: { mean: meanB, std: Math.sqrt(varB / count) },
  };
}

/**
 * Reinhard transfer: shifts `pixels`' own opaque-pixel Lab statistics onto
 * `reference`'s, per channel, then blends the result back toward the
 * original by `1 - strength` — matching the master-plan's own "Strength
 * 100%" slider. Writes into a copy; `pixels` itself is never mutated (this
 * project's own convention for anything a history step has to be able to
 * undo — see CLAUDE.md §4 on the door a `before` snapshot has to stay
 * behind).
 *
 * A source channel with near-zero spread (`std` close to 0 — a flat-colored
 * layer, or a single-pixel sliver) would blow the ratio up toward infinity;
 * guarded by leaving that channel's *offset* only (mean-matched, not
 * variance-stretched) rather than producing a wildly saturated result out
 * of a division by near-zero.
 */
export function harmonizeToReference(pixels: Uint8ClampedArray, width: number, height: number, source: LabStats, reference: LabStats, strength: number): Uint8ClampedArray {
  const amount = Math.max(0, Math.min(1, strength));
  const out = pixels.slice();
  if (amount <= 0) return out;
  const ratio = (channel: LabStats["l"], target: LabStats["l"]) => channel.std > 1e-3 ? target.std / channel.std : 1;
  const rL = ratio(source.l, reference.l), rA = ratio(source.a, reference.a), rB = ratio(source.b, reference.b);
  for (let index = 0; index < out.length; index += 4) {
    if (out[index + 3] === 0) continue;
    const [l, a, b] = rgbToLab(out[index]!, out[index + 1]!, out[index + 2]!);
    const nl = (l - source.l.mean) * rL + reference.l.mean;
    const na = (a - source.a.mean) * rA + reference.a.mean;
    const nb = (b - source.b.mean) * rB + reference.b.mean;
    const [r, g, bl] = labToRgb(l + (nl - l) * amount, a + (na - a) * amount, b + (nb - b) * amount);
    out[index] = Math.round(r); out[index + 1] = Math.round(g); out[index + 2] = Math.round(bl);
  }
  return out;
}
