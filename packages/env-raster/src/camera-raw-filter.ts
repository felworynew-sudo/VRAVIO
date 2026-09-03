import { hslToRgb, rgbToHsl } from "./adjustments";

/**
 * Photoshop's Camera Raw filter, as an RGB-space pass over pixels that are already developed.
 *
 * The real Camera Raw dialog can also reach into undeveloped sensor data when it opens a RAW
 * file directly (that path is `rawDecode.ts`, backed by LibRaw). This is the OTHER half of the
 * feature — Filter > Camera Raw Filter, which Photoshop lets you run on any pixel layer, RAW
 * origin or not. Working entirely in RGB means a few controls (white balance, dehaze) are
 * necessarily approximations of what a true scene-referred RAW pipeline would do, but the same
 * is true of every non-RAW image editor's "Camera Raw"-style filter — there is no Bayer data
 * left to work from once a JPEG or a flattened layer is on screen.
 *
 * Deliberately excluded: Optics (needs a real per-lens calibration database this project doesn't
 * have), Calibration (needs real per-camera-sensor primaries), point Tone Curve (the parametric
 * one below covers the common case), and anything generative or removal-based, per project
 * direction — Camera Raw is a develop filter here, not a retouching tool.
 */
export interface HslChannelAdjustment { hue: number; saturation: number; luminance: number }
export type HslChannelName = "red" | "orange" | "yellow" | "green" | "aqua" | "blue" | "purple" | "magenta";

export interface CameraRawFilterSettings {
  temperature: number; tint: number;
  exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number;
  texture: number; clarity: number; dehaze: number; vibrance: number; saturation: number;
  curveShadows: number; curveDarks: number; curveLights: number; curveHighlights: number;
  sharpenAmount: number; sharpenRadius: number; sharpenDetail: number; sharpenMasking: number;
  noiseLuminance: number; noiseColor: number;
  hsl: Record<HslChannelName, HslChannelAdjustment>;
  vignetteAmount: number; vignetteMidpoint: number; vignetteRoundness: number; vignetteFeather: number;
  grainAmount: number; grainSize: number; grainRoughness: number;
}

const defaultHsl = (): Record<HslChannelName, HslChannelAdjustment> => ({
  red: { hue: 0, saturation: 0, luminance: 0 }, orange: { hue: 0, saturation: 0, luminance: 0 },
  yellow: { hue: 0, saturation: 0, luminance: 0 }, green: { hue: 0, saturation: 0, luminance: 0 },
  aqua: { hue: 0, saturation: 0, luminance: 0 }, blue: { hue: 0, saturation: 0, luminance: 0 },
  purple: { hue: 0, saturation: 0, luminance: 0 }, magenta: { hue: 0, saturation: 0, luminance: 0 },
});

export const defaultCameraRawFilterSettings: CameraRawFilterSettings = {
  temperature: 0, tint: 0,
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
  curveShadows: 0, curveDarks: 0, curveLights: 0, curveHighlights: 0,
  sharpenAmount: 0, sharpenRadius: 1, sharpenDetail: 25, sharpenMasking: 0,
  noiseLuminance: 0, noiseColor: 0,
  hsl: defaultHsl(),
  vignetteAmount: 0, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50,
  grainAmount: 0, grainSize: 25, grainRoughness: 50,
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

/** The 8 hue centers Photoshop's HSL panel names, in 0..1 hue-wheel units, and how wide each
 * channel's soft-edged influence is — a pixel between two centers blends both channels' effect
 * rather than snapping to one, the same way Photoshop's own HSL sliders behave. */
const hslCenters: { name: HslChannelName; hue: number }[] = [
  { name: "red", hue: 0 }, { name: "orange", hue: 30 / 360 }, { name: "yellow", hue: 60 / 360 }, { name: "green", hue: 120 / 360 },
  { name: "aqua", hue: 180 / 360 }, { name: "blue", hue: 240 / 360 }, { name: "purple", hue: 275 / 360 }, { name: "magenta", hue: 320 / 360 },
];

function hueWeight(hue: number, center: number): number {
  let delta = Math.abs(hue - center);
  if (delta > 0.5) delta = 1 - delta;
  const width = 1 / 12; // each of the 8 channels covers a 60° sector, softened at the edges
  return Math.max(0, 1 - delta / (width * 1.8));
}

/** A soft S-curve pivoting on mid-gray, the same shape Levels/Contrast use — `amount` in -1..1. */
function contrastCurve(value: number, amount: number): number {
  if (amount === 0) return value;
  const k = amount * 4;
  return clamp01(0.5 + (value - 0.5) * (1 + k / (1 + Math.abs(k) * (1 - Math.abs(value - 0.5) * 2))));
}

/** Region-selective gain: how much a control aimed at "highlights" or "shadows" should affect a
 * given luminance — a smoothstep centered away from mid-gray, toward white or black respectively. */
function regionWeight(luminance: number, towardWhite: boolean): number {
  const t = towardWhite ? luminance : 1 - luminance;
  return t * t * (3 - 2 * t);
}

function basicAndCurve(r: number, g: number, b: number, s: CameraRawFilterSettings): [number, number, number] {
  // White balance: a simple opposed-channel gain — real WB is a full CCT/tint remap, but this is
  // the standard cheap approximation every RGB-space "raw-style" filter uses when there's no
  // scene-referred data to work from.
  let rr = r / 255, gg = g / 255, bb = b / 255;
  const temp = s.temperature / 100 * 0.3, tint = s.tint / 100 * 0.3;
  rr = clamp01(rr + temp); bb = clamp01(bb - temp); gg = clamp01(gg + tint); rr = clamp01(rr - tint * 0.5); bb = clamp01(bb - tint * 0.5);

  const exposureGain = Math.pow(2, s.exposure);
  rr = clamp01(rr * exposureGain); gg = clamp01(gg * exposureGain); bb = clamp01(bb * exposureGain);

  let luminance = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
  const highlightGain = 1 + (s.highlights / 100) * 0.6 * regionWeight(luminance, true);
  const shadowGain = 1 + (s.shadows / 100) * 0.6 * regionWeight(luminance, false);
  const whiteGain = 1 + (s.whites / 100) * 0.5 * Math.pow(regionWeight(luminance, true), 2);
  const blackGain = 1 + (s.blacks / 100) * 0.5 * Math.pow(regionWeight(luminance, false), 2);
  const toneGain = highlightGain * shadowGain * whiteGain * blackGain;
  rr = clamp01(rr * toneGain); gg = clamp01(gg * toneGain); bb = clamp01(bb * toneGain);

  rr = contrastCurve(rr, s.contrast / 100); gg = contrastCurve(gg, s.contrast / 100); bb = contrastCurve(bb, s.contrast / 100);

  // Parametric tone curve — the same region-weighted mechanism as Basic's Highlights/Shadows,
  // kept as a distinct pass so the two panels compound the way they do in the real dialog.
  luminance = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
  const curveGain = 1
    + (s.curveHighlights / 100) * 0.4 * regionWeight(luminance, true)
    + (s.curveShadows / 100) * 0.4 * regionWeight(luminance, false)
    + (s.curveLights / 100) * 0.3 * regionWeight(clamp01(luminance + 0.15), true)
    + (s.curveDarks / 100) * 0.3 * regionWeight(clamp01(luminance - 0.15), false);
  rr = clamp01(rr * curveGain); gg = clamp01(gg * curveGain); bb = clamp01(bb * curveGain);

  if (s.dehaze !== 0) {
    const amount = s.dehaze / 100;
    const flatness = 1 - Math.abs(rr - gg) - Math.abs(gg - bb) - Math.abs(rr - bb);
    const strength = amount * 0.5 * Math.max(0, flatness);
    rr = contrastCurve(rr, strength); gg = contrastCurve(gg, strength); bb = contrastCurve(bb, strength);
    const [h, sat, l] = rgbToHsl(rr * 255, gg * 255, bb * 255);
    [rr, gg, bb] = hslToRgb(h, clamp01(sat + amount * 0.15), l).map((channel) => channel / 255) as [number, number, number];
  }

  if (s.vibrance !== 0 || s.saturation !== 0) {
    const [h, sat, l] = rgbToHsl(rr * 255, gg * 255, bb * 255);
    const vibrance = s.vibrance / 100, saturation = s.saturation / 100;
    const nextSat = clamp01(sat + saturation * (saturation < 0 ? sat : 1 - sat) + vibrance * (1 - sat) * 0.7);
    [rr, gg, bb] = hslToRgb(h, nextSat, l).map((channel) => channel / 255) as [number, number, number];
  }

  return [rr * 255, gg * 255, bb * 255];
}

function applyHsl(r: number, g: number, b: number, hsl: CameraRawFilterSettings["hsl"]): [number, number, number] {
  const hasAdjustment = hslCenters.some(({ name }) => hsl[name].hue || hsl[name].saturation || hsl[name].luminance);
  if (!hasAdjustment) return [r, g, b];
  const [hue, saturation, luminance] = rgbToHsl(r, g, b);
  let hueShift = 0, satShift = 0, lumShift = 0, totalWeight = 0;
  for (const { name, hue: center } of hslCenters) {
    const weight = hueWeight(hue, center);
    if (weight <= 0) continue;
    const adjustment = hsl[name];
    hueShift += weight * (adjustment.hue / 360) * 0.3; satShift += weight * (adjustment.saturation / 100); lumShift += weight * (adjustment.luminance / 100) * 0.4;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return [r, g, b];
  const nextHue = (hue + hueShift + 1) % 1;
  const nextSat = clamp01(saturation + satShift * (1 - Math.abs(satShift < 0 ? -saturation : 1 - saturation) * 0));
  const nextLum = clamp01(luminance + lumShift);
  return hslToRgb(nextHue, clamp01(nextSat), nextLum);
}

/** Fast box blur, reused for texture/clarity local contrast, luminance noise reduction and the
 * grain/vignette softening passes — the same small kernel `filters.ts`'s own blur uses. */
function boxBlur(source: Float32Array, width: number, height: number, channels: number, radius: number): Float32Array {
  if (radius < 1) return source.slice();
  const output = new Float32Array(source.length), horizontal = new Float32Array(source.length);
  const r = Math.max(1, Math.round(radius)), diameter = r * 2 + 1;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  for (let y = 0; y < height; y += 1) {
    const sums = new Float32Array(channels);
    for (let dx = -r; dx <= r; dx += 1) { const index = (y * width + clampX(dx)) * channels; for (let c = 0; c < channels; c += 1) sums[c]! += source[index + c]!; }
    for (let x = 0; x < width; x += 1) {
      const outIndex = (y * width + x) * channels;
      for (let c = 0; c < channels; c += 1) horizontal[outIndex + c] = sums[c]! / diameter;
      const removeIndex = (y * width + clampX(x - r)) * channels, addIndex = (y * width + clampX(x + r + 1)) * channels;
      for (let c = 0; c < channels; c += 1) sums[c]! += source[addIndex + c]! - source[removeIndex + c]!;
    }
  }
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));
  for (let x = 0; x < width; x += 1) {
    const sums = new Float32Array(channels);
    for (let dy = -r; dy <= r; dy += 1) { const index = (clampY(dy) * width + x) * channels; for (let c = 0; c < channels; c += 1) sums[c]! += horizontal[index + c]!; }
    for (let y = 0; y < height; y += 1) {
      const outIndex = (y * width + x) * channels;
      for (let c = 0; c < channels; c += 1) output[outIndex + c] = sums[c]! / diameter;
      const removeIndex = (clampY(y - r) * width + x) * channels, addIndex = (clampY(y + r + 1) * width + x) * channels;
      for (let c = 0; c < channels; c += 1) sums[c]! += horizontal[addIndex + c]! - horizontal[removeIndex + c]!;
    }
  }
  return output;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function applyCameraRawFilter(source: Uint8ClampedArray, width: number, height: number, settings: CameraRawFilterSettings): Uint8ClampedArray {
  const s = settings;
  const pixels = new Uint8ClampedArray(source.length);

  // Pass 1: Basic + Tone Curve + Dehaze + Vibrance/Saturation + HSL, all per-pixel.
  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4;
    let [r, g, b] = basicAndCurve(source[at]!, source[at + 1]!, source[at + 2]!, s);
    [r, g, b] = applyHsl(r, g, b, s.hsl);
    pixels[at] = byte(r); pixels[at + 1] = byte(g); pixels[at + 2] = byte(b); pixels[at + 3] = source[at + 3]!;
  }

  // Pass 2: Texture/Clarity — local-contrast (unsharp against a blur), fine radius for texture,
  // wider for clarity, matching how Photoshop separates the two.
  if (s.texture !== 0 || s.clarity !== 0) {
    const luminanceFloat = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) { const at = i * 4; luminanceFloat[i] = 0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!; }
    const textureBlur = s.texture !== 0 ? boxBlur(luminanceFloat, width, height, 1, 2) : null;
    const clarityBlur = s.clarity !== 0 ? boxBlur(luminanceFloat, width, height, 1, 14) : null;
    for (let i = 0; i < width * height; i += 1) {
      let delta = 0;
      if (textureBlur) delta += (luminanceFloat[i]! - textureBlur[i]!) * (s.texture / 100) * 1.2;
      if (clarityBlur) delta += (luminanceFloat[i]! - clarityBlur[i]!) * (s.clarity / 100) * 1.0;
      if (delta === 0) continue;
      const at = i * 4;
      pixels[at] = byte(pixels[at]! + delta); pixels[at + 1] = byte(pixels[at + 1]! + delta); pixels[at + 2] = byte(pixels[at + 2]! + delta);
    }
  }

  // Pass 3: Noise Reduction — luminance NR blends toward a blur (denoise), color NR blurs only
  // chroma (in a simple YCbCr split) so it doesn't also soften detail the way luminance NR does.
  if (s.noiseLuminance > 0 || s.noiseColor > 0) {
    const y = new Float32Array(width * height), cb = new Float32Array(width * height), cr = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
      const at = i * 4, r = pixels[at]!, g = pixels[at + 1]!, b = pixels[at + 2]!;
      y[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b; cb[i] = -0.1146 * r - 0.3854 * g + 0.5 * b + 128; cr[i] = 0.5 * r - 0.4542 * g - 0.0458 * b + 128;
    }
    const yBlur = s.noiseLuminance > 0 ? boxBlur(y, width, height, 1, 1) : null;
    const cbBlur = s.noiseColor > 0 ? boxBlur(cb, width, height, 1, 2) : null;
    const crBlur = s.noiseColor > 0 ? boxBlur(cr, width, height, 1, 2) : null;
    const lumMix = s.noiseLuminance / 100, colorMix = s.noiseColor / 100;
    for (let i = 0; i < width * height; i += 1) {
      const nextY = yBlur ? y[i]! + (yBlur[i]! - y[i]!) * lumMix : y[i]!;
      const nextCb = cbBlur ? cb[i]! + (cbBlur[i]! - cb[i]!) * colorMix : cb[i]!;
      const nextCr = crBlur ? cr[i]! + (crBlur[i]! - cr[i]!) * colorMix : cr[i]!;
      const at = i * 4;
      pixels[at] = byte(nextY + 1.5748 * (nextCr - 128));
      pixels[at + 1] = byte(nextY - 0.1873 * (nextCb - 128) - 0.4681 * (nextCr - 128));
      pixels[at + 2] = byte(nextY + 1.8556 * (nextCb - 128));
    }
  }

  // Pass 4: Sharpening — unsharp mask, with Masking limiting the effect to edges (protects flat
  // skies/skin from added noise, exactly what Photoshop's Masking slider is for).
  if (s.sharpenAmount > 0) {
    const luminanceFloat = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) { const at = i * 4; luminanceFloat[i] = 0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!; }
    const blurred = boxBlur(luminanceFloat, width, height, 1, Math.max(0.5, s.sharpenRadius));
    const amount = (s.sharpenAmount / 100) * (0.5 + s.sharpenDetail / 200);
    const maskThreshold = (s.sharpenMasking / 100) * 40;
    for (let i = 0; i < width * height; i += 1) {
      const edge = Math.abs(luminanceFloat[i]! - blurred[i]!);
      if (edge < maskThreshold) continue;
      const delta = (luminanceFloat[i]! - blurred[i]!) * amount;
      const at = i * 4;
      pixels[at] = byte(pixels[at]! + delta); pixels[at + 1] = byte(pixels[at + 1]! + delta); pixels[at + 2] = byte(pixels[at + 2]! + delta);
    }
  }

  // Pass 5: Vignette — radial gain from center, Roundness bends the ellipse toward a rectangle
  // or a circle, Feather softens the transition, Midpoint sets where the falloff starts.
  if (s.vignetteAmount !== 0) {
    const cx = width / 2, cy = height / 2;
    const roundness = s.vignetteRoundness / 100; // -1 rectangular .. 1 circular
    const aspect = width / height;
    const midpoint = s.vignetteMidpoint / 100, feather = Math.max(0.01, s.vignetteFeather / 100);
    const amount = s.vignetteAmount / 100;
    for (let py = 0; py < height; py += 1) for (let px = 0; px < width; px += 1) {
      const nx = (px - cx) / cx, ny = (py - cy) / cy;
      const ellipse = Math.sqrt(nx * nx + ny * ny);
      const rectangular = Math.max(Math.abs(nx), Math.abs(ny) * aspect);
      const shape = ellipse * (1 + roundness) / 2 + rectangular * (1 - roundness) / 2;
      const t = clamp01((shape - midpoint) / feather);
      const gain = 1 + amount * t * t * (3 - 2 * t) * (amount > 0 ? 1 : 1);
      const at = (py * width + px) * 4;
      pixels[at] = byte(pixels[at]! * (amount < 0 ? Math.max(0, gain) : gain));
      pixels[at + 1] = byte(pixels[at + 1]! * (amount < 0 ? Math.max(0, gain) : gain));
      pixels[at + 2] = byte(pixels[at + 2]! * (amount < 0 ? Math.max(0, gain) : gain));
    }
  }

  // Pass 6: Grain — luminance noise with Size controlling how blurred the noise field is (larger
  // = coarser grain) and Roughness controlling how uneven the grain looks.
  if (s.grainAmount > 0) {
    const random = mulberry32(0x9E3779B9);
    const noise = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) noise[i] = random() * 2 - 1;
    const size = Math.max(0.01, s.grainSize / 100) * 3;
    const softened = size > 0.1 ? boxBlur(noise, width, height, 1, size) : noise;
    const roughness = s.grainRoughness / 100;
    const amount = s.grainAmount / 100 * 30;
    for (let i = 0; i < width * height; i += 1) {
      const grain = softened[i]! * (1 - roughness) + noise[i]! * roughness;
      const at = i * 4;
      pixels[at] = byte(pixels[at]! + grain * amount); pixels[at + 1] = byte(pixels[at + 1]! + grain * amount); pixels[at + 2] = byte(pixels[at + 2]! + grain * amount);
    }
  }

  return pixels;
}
