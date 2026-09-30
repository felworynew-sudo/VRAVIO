/**
 * Affine resampling for a transform commit — Krita's transform worker, not a point sampler.
 *
 * What it replaces sampled each destination pixel from the 2×2 source pixels under it, at any
 * scale: fine for enlarging, but shrinking a photo skipped most of its pixels and aliased (the
 * owner's "масштабирование плохо работает в плане сжатия", §65.12). Krita
 * (`kis_transform_worker.cc`, `kis_filter_weights_buffer.h`) does it in this order, and so does
 * this: exact quarter turns first (no resampling at all), then the remaining ±45° and the scale as
 * two separable one-dimensional passes — horizontal with the shear folded in, then vertical — each
 * a filter whose source support is widened by 1/scale when shrinking, so every source pixel
 * contributes, with the weights normalised per destination pixel. Colour is filtered premultiplied
 * by alpha, so a transparent neighbour darkens nothing, in 16 bits so a shrink loses no precision
 * on the way through.
 */

export type Interpolation = "nearest" | "bilinear" | "bicubic" | "mitchell" | "lanczos3";

export const INTERPOLATIONS: readonly Interpolation[] = ["nearest", "bilinear", "bicubic", "mitchell", "lanczos3"];

interface Kernel { readonly support: number; weight(x: number): number }

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

const KERNELS: Record<Exclude<Interpolation, "nearest">, Kernel> = {
  bilinear: { support: 1, weight: (x) => Math.max(0, 1 - Math.abs(x)) },
  // Keys' cubic convolution with a = −0.5 — Krita's and GIMP's "cubic".
  bicubic: {
    support: 2,
    weight: (x) => {
      const t = Math.abs(x), a = -0.5;
      if (t < 1) return ((a + 2) * t - (a + 3)) * t * t + 1;
      if (t < 2) return ((a * t - 5 * a) * t + 8 * a) * t - 4 * a;
      return 0;
    },
  },
  // Mitchell–Netravali, B = C = 1/3: softer than Keys, with less ringing.
  mitchell: {
    support: 2,
    weight: (x) => {
      const t = Math.abs(x), B = 1 / 3, C = 1 / 3;
      if (t < 1) return ((12 - 9 * B - 6 * C) * t * t * t + (-18 + 12 * B + 6 * C) * t * t + (6 - 2 * B)) / 6;
      if (t < 2) return ((-B - 6 * C) * t * t * t + (6 * B + 30 * C) * t * t + (-12 * B - 48 * C) * t + (8 * B + 24 * C)) / 6;
      return 0;
    },
  },
  lanczos3: { support: 3, weight: (x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0) },
};

/** Sub-pixel phases a pass precomputes its weights for — Krita's `KisFilterWeightsBuffer` uses
 * the same 1/256 of a pixel. */
const PHASES = 256;

/**
 * Everything about one pass that does not depend on the line: the kernel, how far it is widened
 * (by 1/scale when shrinking, so every source pixel contributes), and its normalised weights for
 * each of `PHASES` sub-pixel positions. Built once per pass instead of per destination pixel —
 * what made the first version spend seconds recomputing `sin` for Lanczos on every row.
 */
interface Pass {
  readonly scale: number;
  readonly nearest: boolean;
  readonly kernel: Kernel | null;
  readonly widen: number;
  readonly support: number;
  /** Tap `j` of phase `q` reads source pixel `k + first + j`, where `k = ⌊centre − 0.5⌋`. */
  readonly first: number;
  readonly taps: number;
  readonly table: Float32Array;
}

function makePass(scale: number, interpolation: Interpolation): Pass {
  if (interpolation === "nearest") return { scale, nearest: true, kernel: null, widen: 1, support: 0, first: 0, taps: 0, table: new Float32Array(0) };
  const kernel = KERNELS[interpolation];
  const widen = Math.max(1, 1 / Math.abs(scale));
  const support = kernel.support * widen;
  const first = -Math.ceil(support), taps = 2 * Math.ceil(support) + 2;
  const table = new Float32Array((PHASES + 1) * taps);
  for (let q = 0; q <= PHASES; q += 1) {
    const fraction = q / PHASES;
    let total = 0;
    for (let j = 0; j < taps; j += 1) { const w = kernel.weight((first + j - fraction) / widen); table[q * taps + j] = w; total += w; }
    for (let j = 0; j < taps; j += 1) table[q * taps + j] = table[q * taps + j]! / total;
  }
  return { scale, nearest: false, kernel, widen, support, first, taps, table };
}

/**
 * One line through a pass: destination `d` covers source position `((d + 0.5) − offset) / scale`.
 *
 * The image's own edge is handled geometrically, not by the filter. Colour is filtered from the
 * pixels that exist (renormalised over the taps inside the line where a kernel reaches past it,
 * as Pillow does), and each destination pixel is then scaled by how much of it the transformed
 * line actually covers: an edge that lands on a pixel boundary stays exactly crisp, one that lands
 * between is antialiased by its true coverage — through both passes, which gives a turned layer
 * smooth edges. Filtering across the edge instead (transparent taps counted in the sum) left a
 * faint halo one pixel outside a scaled layer and made its outermost pixels translucent.
 * Negative lobes are clamped back into the premultiplied range (colour never above alpha).
 */
function resampleLine(
  pass: Pass, offset: number, inLength: number, outLength: number,
  source: Uint16Array, sourceStart: number, sourceStep: number,
  target: Uint16Array, targetStart: number, targetStep: number,
): void {
  const { scale, table, taps, first, widen, kernel } = pass;
  const edgeA = offset, edgeB = offset + inLength * scale;
  const edgeLow = edgeA < edgeB ? edgeA : edgeB, edgeHigh = edgeA < edgeB ? edgeB : edgeA;
  const start = Math.max(0, Math.floor(edgeLow)), stop = Math.min(outLength, Math.ceil(edgeHigh));
  for (let d = start; d < stop; d += 1) {
    const cover = Math.min(d + 1, edgeHigh) - Math.max(d, edgeLow);
    if (cover <= 0) continue;
    const centre = (d + 0.5 - offset) / scale;
    let r = 0, g = 0, b = 0, a = 0;
    if (pass.nearest) {
      const i = Math.floor(centre);
      if (i < 0 || i >= inLength) continue;
      const at = sourceStart + i * sourceStep;
      r = source[at]!; g = source[at + 1]!; b = source[at + 2]!; a = source[at + 3]!;
    } else {
      let k = Math.floor(centre - 0.5), q = Math.round((centre - 0.5 - k) * PHASES);
      if (q === PHASES) { k += 1; q = 0; }
      const low = k + first, high = low + taps - 1;
      if (low >= 0 && high < inLength) {
        const row = q * taps;
        let at = sourceStart + low * sourceStep;
        for (let j = 0; j < taps; j += 1, at += sourceStep) {
          const w = table[row + j]!;
          if (w === 0) continue;
          r += source[at]! * w; g += source[at + 1]! * w; b += source[at + 2]! * w; a += source[at + 3]! * w;
        }
      } else {
        // At the line's own ends only: the taps that exist, renormalised.
        const from = low < 0 ? 0 : low, to = high >= inLength ? inLength - 1 : high;
        let total = 0;
        for (let i = from; i <= to; i += 1) total += kernel!.weight((i + 0.5 - centre) / widen);
        if (Math.abs(total) < 1e-6) continue;
        let at = sourceStart + from * sourceStep;
        for (let i = from; i <= to; i += 1, at += sourceStep) {
          const w = kernel!.weight((i + 0.5 - centre) / widen) / total;
          r += source[at]! * w; g += source[at + 1]! * w; b += source[at + 2]! * w; a += source[at + 3]! * w;
        }
      }
    }
    const coverage = cover < 1 ? cover : 1;
    r *= coverage; g *= coverage; b *= coverage; a *= coverage;
    const alpha = a < 0 ? 0 : a > 65535 ? 65535 : a;
    const to = targetStart + d * targetStep;
    target[to] = r < 0 ? 0 : r > alpha ? alpha : r;
    target[to + 1] = g < 0 ? 0 : g > alpha ? alpha : g;
    target[to + 2] = b < 0 ? 0 : b > alpha ? alpha : b;
    target[to + 3] = alpha;
  }
}

/** A premultiplied 16-bit RGBA image. */
export interface Premultiplied { readonly data: Uint16Array; readonly width: number; readonly height: number }

/** Exact quarter turn(s) in y-down space, `turns` × 90° the same way `R(θ)` turns (x,y)→(−y,x). */
function quarterTurn(image: Premultiplied, turns: number): Premultiplied {
  const k = ((turns % 4) + 4) % 4;
  if (k === 0) return image;
  const { data, width: w, height: h } = image;
  const odd = k % 2 === 1;
  const width = odd ? h : w, height = odd ? w : h;
  const out = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sx = k === 1 ? y : k === 2 ? w - 1 - x : w - 1 - y;
    const sy = k === 1 ? h - 1 - x : k === 2 ? h - 1 - y : x;
    const from = (sy * w + sx) * 4, to = (y * width + x) * 4;
    out[to] = data[from]!; out[to + 1] = data[from + 1]!; out[to + 2] = data[from + 2]!; out[to + 3] = data[from + 3]!;
  }
  return { data: out, width, height };
}

/** `[a b; c d]` and a translation — destination = M · source + t, source in the image's own
 * pixel space (pixel centres at i + 0.5). */
export interface Affine { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly tx: number; readonly ty: number }

/**
 * Resamples `image` through `m` into the part of destination space `clip` covers. Returns the
 * result with its own top-left in destination space, or null when nothing lands inside `clip`.
 */
export function resampleAffine(image: Premultiplied, m: Affine, interpolation: Interpolation, clip: { x: number; y: number; width: number; height: number }): { image: Premultiplied; x: number; y: number } | null {
  if (!image.width || !image.height) return null;
  // Quarter turns out first, exactly: what remains is within ±45°, where the first pass's own
  // scale (`a` below) is never near zero.
  const turns = Math.round(Math.atan2(m.c, m.a) / (Math.PI / 2));
  const turned = quarterTurn(image, turns);
  const k = ((turns % 4) + 4) % 4;
  // p' = Q·p + shift for the quarter turn; so M' = M·Q⁻¹ and t' = t − M'·shift.
  const [q00, q01, q10, q11] = k === 0 ? [1, 0, 0, 1] : k === 1 ? [0, -1, 1, 0] : k === 2 ? [-1, 0, 0, -1] : [0, 1, -1, 0];
  const [sx, sy] = k === 0 ? [0, 0] : k === 1 ? [image.height, 0] : k === 2 ? [image.width, image.height] : [0, image.width];
  // Q⁻¹ = Qᵀ for a rotation.
  const a = m.a * q00 + m.b * q01, b = m.a * q10 + m.b * q11;
  const c = m.c * q00 + m.d * q01, d = m.c * q10 + m.d * q11;
  const tx = m.tx - (a * sx + b * sy), ty = m.ty - (c * sx + d * sy);
  if (Math.abs(a) < 1e-9) return null;
  const { data, width: w, height: h } = turned;

  // Pass 1, rows: u = a·x + b·y + tx, y unchanged. Destination x is final x, so it clips here.
  const us = [tx, a * w + tx, b * h + tx, a * w + b * h + tx];
  const u0 = Math.max(Math.floor(Math.min(...us)) - 1, clip.x), u1 = Math.min(Math.ceil(Math.max(...us)) + 1, clip.x + clip.width);
  if (u1 <= u0) return null;
  const midWidth = u1 - u0;
  const middle = new Uint16Array(midWidth * h * 4);
  const rows = makePass(a, interpolation);
  for (let row = 0; row < h; row += 1) resampleLine(rows, b * (row + 0.5) + tx - u0, w, midWidth, data, row * w * 4, 4, middle, row * midWidth * 4, 4);

  // Pass 2, columns: y' = (c/a)·u + (det/a)·y + (ty − c·tx/a).
  const slope = c / a, scaleY = (a * d - b * c) / a, base = ty - c * tx / a;
  const vs = [slope * u0 + base, slope * u1 + base, slope * u0 + scaleY * h + base, slope * u1 + scaleY * h + base];
  const v0 = Math.max(Math.floor(Math.min(...vs)) - 1, clip.y), v1 = Math.min(Math.ceil(Math.max(...vs)) + 1, clip.y + clip.height);
  if (v1 <= v0 || Math.abs(scaleY) < 1e-9) return null;
  const outHeight = v1 - v0;
  const out = new Uint16Array(midWidth * outHeight * 4);
  const columns = makePass(scaleY, interpolation);
  for (let column = 0; column < midWidth; column += 1) resampleLine(columns, slope * (u0 + column + 0.5) + base - v0, h, outHeight, middle, column * 4, midWidth * 4, out, column * 4, midWidth * 4);
  return { image: { data: out, width: midWidth, height: outHeight }, x: u0, y: v0 };
}
