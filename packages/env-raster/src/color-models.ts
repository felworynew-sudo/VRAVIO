import { rasterColorSpaceById, rasterColorSpaces, rgbToXyzMatrix, toLinear, fromLinear, adaptation, multiplyMatrix, type RasterColorSpace } from "./color-space";

/**
 * Colour models other than RGB: CIE L*a*b* and CMYK (docs/master-plan.md §59.3).
 *
 * A colour *space* says what RGB numbers mean (`color-space.ts`); a colour *model* says what the
 * channels are at all. Photoshop's Image ▸ Mode lists both kinds together, which is why they meet
 * here.
 *
 * Lab is device-independent and exact: XYZ under D50 through the CIE formulas, no profile needed
 * beyond the document's own space. CMYK is not — real CMYK is a printing condition described by a
 * profile with ink limits, dot gain and black generation, and no formula stands in for one. What
 * this module implements is the naive separation with GCR that every editor falls back to when no
 * printer profile is loaded (GIMP's own `gimp-image-convert-color-profile` fallback and the
 * classic "US Web Coated feel" approximation are both this, plus a profile): K from the darkest
 * ink, CMY reduced by it. Said plainly rather than implied, because a CMYK number that claims to
 * be a printer's is worse than one that admits it is a model.
 */

export type RasterColorModel = "rgb" | "grayscale" | "lab" | "cmyk" | "indexed";

export interface LabColor { readonly l: number; readonly a: number; readonly b: number; }
export interface CmykColor { readonly c: number; readonly m: number; readonly y: number; readonly k: number; }

const D50: readonly [number, number] = [0.34567, 0.35850];
const D50_XYZ: readonly [number, number, number] = [0.9642, 1, 0.8249];

/** sRGB (or whichever working space) → XYZ under D50, which is the white point Lab is defined at
 *  in every ICC workflow. Cached per space: the matrix build is a matrix inversion. */
const d50MatrixCache = new Map<RasterColorSpace, readonly number[]>();
function matrixFor(space: RasterColorSpace): readonly number[] {
  const cached = d50MatrixCache.get(space);
  if (cached) return cached;
  const info = rasterColorSpaceById(space) ?? rasterColorSpaces[0]!;
  const matrix = multiplyMatrix(adaptation(info.whitePoint, D50), rgbToXyzMatrix(info));
  d50MatrixCache.set(space, matrix);
  return matrix;
}

const inverseCache = new Map<RasterColorSpace, readonly number[]>();
function inverseMatrixFor(space: RasterColorSpace): readonly number[] {
  const cached = inverseCache.get(space);
  if (cached) return cached;
  const m = matrixFor(space);
  const determinant = m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  const scale = 1 / determinant;
  const inverse = [
    (m[4]! * m[8]! - m[5]! * m[7]!) * scale, (m[2]! * m[7]! - m[1]! * m[8]!) * scale, (m[1]! * m[5]! - m[2]! * m[4]!) * scale,
    (m[5]! * m[6]! - m[3]! * m[8]!) * scale, (m[0]! * m[8]! - m[2]! * m[6]!) * scale, (m[2]! * m[3]! - m[0]! * m[5]!) * scale,
    (m[3]! * m[7]! - m[4]! * m[6]!) * scale, (m[1]! * m[6]! - m[0]! * m[7]!) * scale, (m[0]! * m[4]! - m[1]! * m[3]!) * scale,
  ];
  inverseCache.set(space, inverse);
  return inverse;
}

const labF = (value: number): number => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116;
const labFInverse = (value: number): number => value ** 3 > 216 / 24389 ? value ** 3 : (116 * value - 16) * 27 / 24389;

/** 8-bit RGB in `space` → CIE L*a*b* (L 0…100, a/b roughly −128…127). */
export function rgbToLab(r: number, g: number, b: number, space: RasterColorSpace = "srgb"): LabColor {
  const info = rasterColorSpaceById(space) ?? rasterColorSpaces[0]!;
  const m = matrixFor(space);
  const lr = toLinear(r / 255, info.transfer), lg = toLinear(g / 255, info.transfer), lb = toLinear(b / 255, info.transfer);
  const x = (m[0]! * lr + m[1]! * lg + m[2]! * lb) / D50_XYZ[0];
  const y = m[3]! * lr + m[4]! * lg + m[5]! * lb;
  const z = (m[6]! * lr + m[7]! * lg + m[8]! * lb) / D50_XYZ[2];
  const fx = labF(x), fy = labF(y), fz = labF(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** The inverse, clipped into the space's own range on the way back — a Lab colour outside the
 *  working space's gamut has no RGB triple, and clipping is what relative colorimetric does. */
export function labToRgb(lab: LabColor, space: RasterColorSpace = "srgb"): [number, number, number] {
  const info = rasterColorSpaceById(space) ?? rasterColorSpaces[0]!;
  const inverse = inverseMatrixFor(space);
  const fy = (lab.l + 16) / 116, fx = fy + lab.a / 500, fz = fy - lab.b / 200;
  const x = labFInverse(fx) * D50_XYZ[0], y = labFInverse(fy), z = labFInverse(fz) * D50_XYZ[2];
  const lr = inverse[0]! * x + inverse[1]! * y + inverse[2]! * z;
  const lg = inverse[3]! * x + inverse[4]! * y + inverse[5]! * z;
  const lb = inverse[6]! * x + inverse[7]! * y + inverse[8]! * z;
  const encode = (value: number) => Math.max(0, Math.min(255, Math.round(fromLinear(Math.max(0, Math.min(1, value)), info.transfer) * 255)));
  return [encode(lr), encode(lg), encode(lb)];
}

/**
 * RGB → CMYK, naive separation with full grey-component replacement.
 *
 * This is a model, not a printing condition: without an output profile there is no ink limit, no
 * dot gain and no black generation curve to honour, and every editor without a loaded profile does
 * exactly this. Values are 0…1.
 */
export function rgbToCmyk(r: number, g: number, b: number): CmykColor {
  const red = r / 255, green = g / 255, blue = b / 255;
  const k = 1 - Math.max(red, green, blue);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  const scale = 1 / (1 - k);
  return { c: (1 - red - k) * scale, m: (1 - green - k) * scale, y: (1 - blue - k) * scale, k };
}

export function cmykToRgb(cmyk: CmykColor): [number, number, number] {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(255 * (1 - Math.min(1, value)) * (1 - Math.min(1, cmyk.k)))));
  return [channel(cmyk.c), channel(cmyk.m), channel(cmyk.y)];
}

/**
 * An RGBA buffer taken through a CMYK round trip in place — the colours a four-ink process can
 * actually reproduce, and nothing else.
 *
 * This is what makes "CMYK mode" a fact rather than a label in this editor: the pixels really are
 * limited to the separation's gamut, so a neon green stops being neon the moment the document
 * enters the mode, exactly as it does in Photoshop. What this editor does *not* do (§59.3) is store
 * four ink channels, so there is no per-plate curve yet; the plates are derived on export.
 */
export function limitToCmykGamut(pixels: Uint8ClampedArray): void {
  for (let index = 0; index < pixels.length; index += 4) {
    if (!pixels[index + 3]) continue;
    const [r, g, b] = cmykToRgb(rgbToCmyk(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!));
    pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b;
  }
}

/** The four ink planes of an RGBA buffer, each one byte per pixel — what a CMYK TIFF stores and
 *  what a separation preview shows. */
export function cmykPlanes(pixels: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const planes = new Uint8ClampedArray(width * height * 4);
  for (let index = 0, target = 0; index < pixels.length; index += 4, target += 4) {
    const { c, m, y, k } = rgbToCmyk(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!);
    planes[target] = Math.round(c * 255); planes[target + 1] = Math.round(m * 255);
    planes[target + 2] = Math.round(y * 255); planes[target + 3] = Math.round(k * 255);
  }
  return planes;
}

/**
 * Lab storage encoding, and the pair that moves a whole buffer in and out of it.
 *
 * Lab channels do not fit bytes as they are: L runs 0…100, and the two colour axes are signed, so a Lab
 * document stores L*·255/100 and a*+128, b*+128, which is exactly the encoding Photoshop's own
 * 8-bit Lab mode uses and what a Lab TIFF holds. Alpha is untouched: it is coverage, not colour.
 *
 * Storing Lab rather than converting on the fly is what makes the mode real: a curve or a levels
 * adjustment in a Lab document operates on lightness and the two colour axes, which is the whole
 * reason anyone switches to Lab.
 */
export function rgbToLabEncoded(pixels: Uint8ClampedArray, space: RasterColorSpace = "srgb"): Uint8ClampedArray {
  const output = new Uint8ClampedArray(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    const { l, a, b } = rgbToLab(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!, space);
    output[index] = Math.round(l * 255 / 100);
    output[index + 1] = Math.round(a + 128);
    output[index + 2] = Math.round(b + 128);
    output[index + 3] = pixels[index + 3]!;
  }
  return output;
}

export function labEncodedToRgb(pixels: Uint8ClampedArray, space: RasterColorSpace = "srgb"): Uint8ClampedArray {
  const output = new Uint8ClampedArray(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    const [r, g, b] = labToRgb({ l: pixels[index]! * 100 / 255, a: pixels[index + 1]! - 128, b: pixels[index + 2]! - 128 }, space);
    output[index] = r; output[index + 1] = g; output[index + 2] = b; output[index + 3] = pixels[index + 3]!;
  }
  return output;
}
