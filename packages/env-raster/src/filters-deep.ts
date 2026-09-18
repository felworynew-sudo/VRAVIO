import { allocatePixels, bufferDepth, depthMaximum, type PixelBuffer } from "./pixel-format";

/**
 * Filters that compute at the layer's real depth (docs/master-plan.md §59.2b).
 *
 * The catalogue's seventy-nine filters are written against `Uint8ClampedArray` and packed tightly
 * for speed (CLAUDE.md §5) — rewriting all of them generically would undo exactly the optimisation
 * that makes them usable. babl's own answer applies: an operation declares the format it works in,
 * and the ones that have not declared anything keep getting an 8-bit view. What changes here is
 * that the filters where depth *visibly* matters now declare it.
 *
 * Which ones, and why those:
 *
 *   - **Blurs** (box, gaussian). A blur is an average, and an average of eight-bit numbers rounded
 *     back into eight bits is where banding in a sky comes from. Both already compute in float
 *     internally — only their input and output were narrow — so at depth they are the same
 *     algorithm with a wider container.
 *   - **Sharpen, unsharp mask, high pass**, which are a blur plus a difference: the difference is
 *     small by definition, and small differences are what eight bits cannot hold.
 *   - **Point filters** whose formula is exact (invert, grayscale, desaturate, threshold,
 *     posterize, brightness/contrast). These are cheap to state correctly at any depth, and their
 *     8-bit behaviour is reproduced exactly — a test pins each one against the 8-bit filter.
 *
 * Everything else still runs through the 8-bit view, and the filter panel says so out loud in a
 * deep document rather than letting the user assume otherwise.
 */

export const DEEP_FILTER_IDS: readonly string[] = [
  "box_blur", "gaussian_blur", "sharpen", "unsharp_mask", "high_pass",
  "invert", "grayscale", "desaturate", "threshold", "posterize", "brightness_contrast",
];

const deepSet = new Set(DEEP_FILTER_IDS);

/** Whether this filter has a depth-aware implementation, or will run on an 8-bit view. */
export const filterRunsAtDepth = (id: string): boolean => deepSet.has(id);

const value = (settings: Record<string, number>, key: string, fallback: number): number =>
  Number.isFinite(settings[key]) ? settings[key]! : fallback;

/** Separable box blur over any depth — the same clamped-edge, `r*2+1` window the 8-bit `blur` uses. */
function boxBlurDeep(source: PixelBuffer, width: number, height: number, radius: number): PixelBuffer {
  const depth = bufferDepth(source);
  const r = Math.max(1, Math.min(32, Math.round(radius)));
  const diameter = r * 2 + 1;
  const horizontal = new Float32Array(source.length);
  const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit - 1, value));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const out = (y * width + x) * 4;
    for (let offset = -r; offset <= r; offset += 1) {
      const from = (y * width + clamp(x + offset, width)) * 4;
      for (let channel = 0; channel < 4; channel += 1) horizontal[out + channel] = horizontal[out + channel]! + source[from + channel]!;
    }
    for (let channel = 0; channel < 4; channel += 1) horizontal[out + channel] = horizontal[out + channel]! / diameter;
  }
  const output = allocatePixels(depth, source.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const out = (y * width + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      let total = 0;
      for (let offset = -r; offset <= r; offset += 1) total += horizontal[(clamp(y + offset, height) * width + x) * 4 + channel]!;
      output[out + channel] = total / diameter;
    }
  }
  return output;
}

/** Separable gaussian over any depth — same sigma (r/2) and same clamped edges as the 8-bit one. */
function gaussianBlurDeep(source: PixelBuffer, width: number, height: number, radius: number): PixelBuffer {
  const depth = bufferDepth(source);
  const r = Math.max(1, Math.min(32, Math.round(radius)));
  const sigma = Math.max(0.5, r / 2);
  const weights = new Float64Array(r * 2 + 1);
  let total = 0;
  for (let offset = -r; offset <= r; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    weights[offset + r] = weight;
    total += weight;
  }
  for (let index = 0; index < weights.length; index += 1) weights[index] = weights[index]! / total;
  const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit - 1, value));
  const horizontal = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const out = (y * width + x) * 4;
    for (let offset = -r; offset <= r; offset += 1) {
      const from = (y * width + clamp(x + offset, width)) * 4, weight = weights[offset + r]!;
      for (let channel = 0; channel < 4; channel += 1) horizontal[out + channel] = horizontal[out + channel]! + source[from + channel]! * weight;
    }
  }
  const output = allocatePixels(depth, source.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const out = (y * width + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      let sum = 0;
      for (let offset = -r; offset <= r; offset += 1) sum += horizontal[(clamp(y + offset, height) * width + x) * 4 + channel]! * weights[offset + r]!;
      output[out + channel] = sum;
    }
  }
  return output;
}

/**
 * Runs a depth-capable filter at the buffer's own depth.
 *
 * Throws for a filter that has not declared depth support, rather than silently doing something
 * else: the caller asked for this one specifically, and `filterRunsAtDepth` is how it asks whether
 * that is possible (CLAUDE.md §4 — "не получилось" and "нечего было" are different answers).
 */
export function applyRasterFilterDeep(source: PixelBuffer, width: number, height: number, id: string, settings: Record<string, number> = {}): PixelBuffer {
  if (!deepSet.has(id)) throw new RangeError(`applyRasterFilterDeep: ${id} has no depth-aware implementation; ask filterRunsAtDepth first`);
  const depth = bufferDepth(source);
  const maximum = depthMaximum(depth);
  const clip = depth === 32 ? (value: number) => value : (value: number) => Math.max(0, Math.min(maximum, value));

  // Radius 2 when the setting is absent, matching the 8-bit dispatch exactly — the catalogue's
  // own declared default for this slider is 1, and the two disagreeing is an existing quirk, not
  // something to fix silently on one side only.
  if (id === "box_blur") return boxBlurDeep(source, width, height, value(settings, "radius", 2));
  if (id === "gaussian_blur") return gaussianBlurDeep(source, width, height, value(settings, "radius", 2));

  if (id === "sharpen" || id === "unsharp_mask" || id === "high_pass") {
    // The same three shapes as the 8-bit catalogue: sharpen and unsharp add the detail back,
    // high pass keeps only the detail around mid-grey. Radii match the 8-bit ones exactly.
    const output = allocatePixels(depth, source.length);
    const half = maximum / 2;
    if (id === "unsharp_mask") {
      // Box blur and the same defaults as the 8-bit dispatch (radius 2, amount 150 %, threshold 8),
      // and Patchy's own calibration: the signed detail is scaled first, then the threshold comes
      // off its *magnitude*, so a flat area under the threshold is left alone rather than nudged.
      const blurred = boxBlurDeep(source, width, height, value(settings, "radius", 2));
      const strength = value(settings, "amount", 150) / 100;
      const threshold = value(settings, "threshold", 8) / 255 * maximum;
      for (let index = 0; index < source.length; index += 4) {
        for (let channel = 0; channel < 3; channel += 1) {
          const detail = (source[index + channel]! - blurred[index + channel]!) * strength, magnitude = Math.abs(detail);
          const clipped = magnitude <= threshold ? 0 : (magnitude - threshold) * Math.sign(detail);
          output[index + channel] = clip(source[index + channel]! + clipped);
        }
        output[index + 3] = source[index + 3]!;
      }
      return output;
    }
    const blurred = boxBlurDeep(source, width, height, id === "sharpen" ? 2 : value(settings, "radius", 10));
    for (let index = 0; index < source.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const detail = source[index + channel]! - blurred[index + channel]!;
        output[index + channel] = clip(id === "sharpen" ? source[index + channel]! + detail * 2 : half + detail * 2);
      }
      output[index + 3] = source[index + 3]!;
    }
    return output;
  }

  const output = allocatePixels(depth, source.length);
  const threshold = value(settings, "threshold", 128) / 255 * maximum;
  const levels = Math.max(1, Math.round(value(settings, "levels", 4)) - 1);
  const brightness = value(settings, "brightness", 0) / 100 * maximum;
  const contrast = Math.max(-255, Math.min(255, value(settings, "contrast", 20) * 2.55));
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  for (let index = 0; index < source.length; index += 4) {
    const r = source[index]!, g = source[index + 1]!, b = source[index + 2]!;
    // The same NTSC luma weights the 8-bit catalogue uses, so grayscale means one thing here.
    const luma = (r * 30 + g * 59 + b * 11) / 100;
    let nr = r, ng = g, nb = b;
    if (id === "invert") { nr = maximum - r; ng = maximum - g; nb = maximum - b; }
    else if (id === "grayscale" || id === "desaturate") { nr = ng = nb = luma; }
    else if (id === "threshold") { nr = ng = nb = luma >= threshold ? maximum : 0; }
    else if (id === "posterize") { const quantize = (value: number) => Math.round(value * levels / maximum) * maximum / levels; nr = quantize(r); ng = quantize(g); nb = quantize(b); }
    else { const point = (value: number) => factor * (value + brightness - maximum / 2) + maximum / 2; nr = point(r); ng = point(g); nb = point(b); }
    output[index] = clip(nr); output[index + 1] = clip(ng); output[index + 2] = clip(nb);
    output[index + 3] = source[index + 3]!;
  }
  return output;
}
