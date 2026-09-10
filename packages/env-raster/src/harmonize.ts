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

/** Separable box blur over a single float plane, edges clamped to the plane's own bounds
 *  (not the document's) — the same technique `camera-raw-filter.ts`'s own private `boxBlur`
 *  uses for its texture/clarity passes, reimplemented here single-channel because this module
 *  blurs a small cropped Lab plane, not a whole-document interleaved RGB buffer, and re-exporting
 *  the other one under the same name would collide with `selection.ts`'s own unrelated
 *  (Uint8ClampedArray mask) `boxBlur` at the package's `export *` boundary. */
function boxBlurPlane(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius < 1) return source.slice();
  const output = new Float32Array(source.length), horizontal = new Float32Array(source.length);
  const r = Math.max(1, Math.round(radius)), diameter = r * 2 + 1;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let dx = -r; dx <= r; dx += 1) sum += source[y * width + clampX(dx)]!;
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / diameter;
      sum += source[y * width + clampX(x + r + 1)]! - source[y * width + clampX(x - r)]!;
    }
  }
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let dy = -r; dy <= r; dy += 1) sum += horizontal[clampY(dy) * width + x]!;
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / diameter;
      sum += horizontal[clampY(y + r + 1) * width + x]! - horizontal[clampY(y - r) * width + x]!;
    }
  }
  return output;
}

/** Three box-blur passes approximate a Gaussian well (the standard trick for a cheap large-radius
 *  blur) — this is the module's own low-frequency band of a multi-scale decomposition, see
 *  `harmonizeToReference`'s own comment. */
function lowFrequencyPlane(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  return boxBlurPlane(boxBlurPlane(boxBlurPlane(source, width, height, radius), width, height, radius), width, height, radius);
}

/**
 * Multi-scale Reinhard transfer — a one-band simplification of Sunkavalli et
 * al.'s "Multi-scale Image Harmonization" (SIGGRAPH 2010): the owner
 * reported the plain single-statistic version below performed badly, and
 * the reason a global mean/std match washes out is exactly the problem that
 * paper names — moving every pixel by the same amount matches the *color
 * cast*, but it also flattens whatever local contrast and texture the layer
 * actually had, since detail is just as displaced as the cast is. Sunkavalli's
 * own fix decomposes both images into a Laplacian pyramid and matches
 * statistics band by band, so texture stays put and only the broad,
 * low-frequency lighting/color cast — the actual mismatch a composited layer
 * has with its new background — gets corrected. This keeps that same split
 * to one band instead of a full pyramid: a heavily blurred low-frequency
 * plane per Lab channel carries the "what color/light is this object sitting
 * in" signal, matched to `reference`'s statistics the same way the old
 * single-band version matched the whole layer; the leftover
 * (`original - lowFrequency`) detail plane is added back completely
 * unchanged, so edges, texture and noise never move.
 *
 * Writes into a copy; `pixels` itself is never mutated (this project's own
 * convention for anything a history step has to be able to undo — see
 * CLAUDE.md §4 on the door a `before` snapshot has to stay behind).
 *
 * A source channel with near-zero spread (`std` close to 0 — a flat-colored
 * layer, or a single-pixel sliver) would blow the ratio up toward infinity;
 * guarded by leaving that channel's *offset* only (mean-matched, not
 * variance-stretched) rather than producing a wildly saturated result out
 * of a division by near-zero.
 *
 * `bounds` scopes the blur to the layer's own opaque footprint (defaulting
 * to the whole buffer when omitted, e.g. in tests that already pass a
 * document-sized solid buffer): blurring the full document buffer would let
 * the transparent pixels surrounding a layer bleed a black, zero-alpha
 * fringe into the low-frequency plane right at the layer's own edge.
 */
export function harmonizeToReference(pixels: Uint8ClampedArray, width: number, height: number, source: LabStats, reference: LabStats, strength: number, bounds?: { x: number; y: number; width: number; height: number }): Uint8ClampedArray {
  const amount = Math.max(0, Math.min(1, strength));
  const out = pixels.slice();
  if (amount <= 0) return out;

  const left = Math.max(0, Math.floor(bounds?.x ?? 0)), top = Math.max(0, Math.floor(bounds?.y ?? 0));
  const right = Math.min(width, Math.ceil(bounds ? bounds.x + bounds.width : width)), bottom = Math.min(height, Math.ceil(bounds ? bounds.y + bounds.height : height));
  const w = right - left, h = bottom - top;
  if (w <= 0 || h <= 0) return out;

  const l = new Float32Array(w * h), a = new Float32Array(w * h), b = new Float32Array(w * h);
  const opaque = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const index = ((top + y) * width + (left + x)) * 4;
      if (out[index + 3] === 0) continue;
      const [lv, av, bv] = rgbToLab(out[index]!, out[index + 1]!, out[index + 2]!);
      const i = y * w + x;
      l[i] = lv; a[i] = av; b[i] = bv; opaque[i] = 1;
    }
  }

  // Big enough to isolate broad lighting/color cast, small enough to still respond to the
  // layer's own actual footprint rather than one fixed radius for every object size.
  const radius = Math.max(2, Math.round(Math.max(w, h) * 0.12));
  const lowL = lowFrequencyPlane(l, w, h, radius), lowA = lowFrequencyPlane(a, w, h, radius), lowB = lowFrequencyPlane(b, w, h, radius);

  const ratio = (channel: LabStats["l"], target: LabStats["l"]) => channel.std > 1e-3 ? target.std / channel.std : 1;
  const rL = ratio(source.l, reference.l), rA = ratio(source.a, reference.a), rB = ratio(source.b, reference.b);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!opaque[i]) continue;
      const detailL = l[i]! - lowL[i]!, detailA = a[i]! - lowA[i]!, detailB = b[i]! - lowB[i]!;
      const matchedLowL = (lowL[i]! - source.l.mean) * rL + reference.l.mean;
      const matchedLowA = (lowA[i]! - source.a.mean) * rA + reference.a.mean;
      const matchedLowB = (lowB[i]! - source.b.mean) * rB + reference.b.mean;
      const nl = matchedLowL + detailL, na = matchedLowA + detailA, nb = matchedLowB + detailB;
      const index = ((top + y) * width + (left + x)) * 4;
      const [r, g, bl] = labToRgb(l[i]! + (nl - l[i]!) * amount, a[i]! + (na - a[i]!) * amount, b[i]! + (nb - b[i]!) * amount);
      out[index] = Math.round(r); out[index + 1] = Math.round(g); out[index + 2] = Math.round(bl);
    }
  }
  return out;
}
