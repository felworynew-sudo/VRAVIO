/**
 * Working colour spaces for a raster document, and conversion between them.
 *
 * Krita's own model (`KoColorSpaceRegistry`: colour model + depth + profile) is the shape this
 * follows, minus ICC files: the spaces a photo editor actually works in are a handful of
 * well-known primaries and transfer functions, and those are exact numbers, not a file to parse.
 * A document carries which one it is in; converting between two of them is
 * `encoded → linear → XYZ → linear → encoded`, the same chain babl performs for GIMP.
 *
 * Deliberately not here (yet): arbitrary ICC profiles from a file, CMYK and Lab models, and
 * rendering intents beyond relative colorimetric — see docs/master-plan.md §59 for what each
 * would take.
 */

export type RasterColorSpace = "srgb" | "linear-srgb" | "display-p3" | "adobe-rgb" | "prophoto-rgb";

export interface RasterColorSpaceInfo {
  readonly id: RasterColorSpace;
  readonly label: { readonly en: string; readonly ru: string };
  /** Red, green and blue primaries as CIE xy, and the white point. */
  readonly primaries: readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
  readonly whitePoint: readonly [number, number];
  readonly transfer: "srgb" | "linear" | "gamma-2.2" | "prophoto";
}

const D65: readonly [number, number] = [0.3127, 0.3290];
const D50: readonly [number, number] = [0.34567, 0.35850];

export const rasterColorSpaces: readonly RasterColorSpaceInfo[] = [
  { id: "srgb", label: { en: "sRGB", ru: "sRGB" }, primaries: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]], whitePoint: D65, transfer: "srgb" },
  { id: "linear-srgb", label: { en: "Linear sRGB", ru: "Линейный sRGB" }, primaries: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]], whitePoint: D65, transfer: "linear" },
  { id: "display-p3", label: { en: "Display P3", ru: "Display P3" }, primaries: [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]], whitePoint: D65, transfer: "srgb" },
  { id: "adobe-rgb", label: { en: "Adobe RGB (1998)", ru: "Adobe RGB (1998)" }, primaries: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], whitePoint: D65, transfer: "gamma-2.2" },
  { id: "prophoto-rgb", label: { en: "ProPhoto RGB", ru: "ProPhoto RGB" }, primaries: [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]], whitePoint: D50, transfer: "prophoto" },
];

export const rasterColorSpaceById = (id: string): RasterColorSpaceInfo | undefined => rasterColorSpaces.find((space) => space.id === id);

/** The canvas colour space a document can be shown in directly; anything else is converted to sRGB
 *  for display (the browser has no wider canvas space than Display P3 today). */
export const canvasColorSpaceFor = (space: RasterColorSpace): "srgb" | "display-p3" => space === "display-p3" ? "display-p3" : "srgb";

type Matrix = readonly [number, number, number, number, number, number, number, number, number];

const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];

function invert(m: Matrix): Matrix {
  const determinant = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(determinant) < 1e-12) throw new RangeError("Colour space matrix is not invertible");
  const inverse = 1 / determinant;
  return [
    (m[4] * m[8] - m[5] * m[7]) * inverse, (m[2] * m[7] - m[1] * m[8]) * inverse, (m[1] * m[5] - m[2] * m[4]) * inverse,
    (m[5] * m[6] - m[3] * m[8]) * inverse, (m[0] * m[8] - m[2] * m[6]) * inverse, (m[2] * m[3] - m[0] * m[5]) * inverse,
    (m[3] * m[7] - m[4] * m[6]) * inverse, (m[1] * m[6] - m[0] * m[7]) * inverse, (m[0] * m[4] - m[1] * m[3]) * inverse,
  ];
}

const xyzFromXy = ([x, y]: readonly [number, number]): readonly [number, number, number] => [x / y, 1, (1 - x - y) / y];

/** Primaries and a white point to the RGB→XYZ matrix — the standard construction (Lindbloom). */
function rgbToXyzMatrix(space: RasterColorSpaceInfo): Matrix {
  const [r, g, b] = space.primaries;
  const base: Matrix = [
    r[0] / r[1], g[0] / g[1], b[0] / b[1],
    1, 1, 1,
    (1 - r[0] - r[1]) / r[1], (1 - g[0] - g[1]) / g[1], (1 - b[0] - b[1]) / b[1],
  ];
  const white = xyzFromXy(space.whitePoint);
  const inverse = invert(base);
  const scale: readonly [number, number, number] = [
    inverse[0] * white[0] + inverse[1] * white[1] + inverse[2] * white[2],
    inverse[3] * white[0] + inverse[4] * white[1] + inverse[5] * white[2],
    inverse[6] * white[0] + inverse[7] * white[1] + inverse[8] * white[2],
  ];
  return [
    base[0] * scale[0], base[1] * scale[1], base[2] * scale[2],
    base[3] * scale[0], base[4] * scale[1], base[5] * scale[2],
    base[6] * scale[0], base[7] * scale[1], base[8] * scale[2],
  ];
}

/** Bradford chromatic adaptation — what to do when the two spaces have different white points
 *  (ProPhoto is D50, the rest D65). Relative colorimetric, as everything here is. */
function adaptation(from: readonly [number, number], to: readonly [number, number]): Matrix {
  if (from[0] === to[0] && from[1] === to[1]) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const bradford: Matrix = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  const inverseBradford = invert(bradford);
  const source = xyzFromXy(from), destination = xyzFromXy(to);
  const cone = (xyz: readonly [number, number, number]): readonly [number, number, number] => [
    bradford[0] * xyz[0] + bradford[1] * xyz[1] + bradford[2] * xyz[2],
    bradford[3] * xyz[0] + bradford[4] * xyz[1] + bradford[5] * xyz[2],
    bradford[6] * xyz[0] + bradford[7] * xyz[1] + bradford[8] * xyz[2],
  ];
  const [sr, sg, sb] = cone(source), [dr, dg, db] = cone(destination);
  const ratio: Matrix = [dr / sr, 0, 0, 0, dg / sg, 0, 0, 0, db / sb];
  return multiply(inverseBradford, multiply(ratio, bradford));
}

const toLinear = (value: number, transfer: RasterColorSpaceInfo["transfer"]): number => {
  if (transfer === "linear") return value;
  if (transfer === "gamma-2.2") return value < 0 ? -Math.pow(-value, 2.19921875) : Math.pow(value, 2.19921875);
  if (transfer === "prophoto") return value < 16 / 512 ? value / 16 : Math.pow(value, 1.8);
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
};

const fromLinear = (value: number, transfer: RasterColorSpaceInfo["transfer"]): number => {
  if (transfer === "linear") return value;
  if (transfer === "gamma-2.2") return value < 0 ? -Math.pow(-value, 1 / 2.19921875) : Math.pow(value, 1 / 2.19921875);
  if (transfer === "prophoto") return value < 1 / 512 ? value * 16 : Math.pow(value, 1 / 1.8);
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
};

/** The one matrix that carries linear RGB from one space to the other, white point included. */
export function colorSpaceMatrix(from: RasterColorSpace, to: RasterColorSpace): Matrix {
  const source = rasterColorSpaceById(from) ?? rasterColorSpaces[0]!;
  const destination = rasterColorSpaceById(to) ?? rasterColorSpaces[0]!;
  const toXyz = rgbToXyzMatrix(source);
  const fromXyz = invert(rgbToXyzMatrix(destination));
  return multiply(fromXyz, multiply(adaptation(source.whitePoint, destination.whitePoint), toXyz));
}

/**
 * Converts an RGBA buffer from one working space to another, in place-safe fashion (a new buffer).
 *
 * Straight alpha is left exactly as it is: alpha is not a colour and no colour space transforms it.
 * Out-of-gamut colours are clipped at the destination's own range — relative colorimetric with no
 * gamut mapping, which is what "Convert to Profile" does by default in the donors too.
 */
export function convertPixelsColorSpace(pixels: Uint8ClampedArray, from: RasterColorSpace, to: RasterColorSpace): Uint8ClampedArray {
  if (from === to) return pixels.slice();
  const source = rasterColorSpaceById(from) ?? rasterColorSpaces[0]!;
  const destination = rasterColorSpaceById(to) ?? rasterColorSpaces[0]!;
  const m = colorSpaceMatrix(from, to);
  const output = new Uint8ClampedArray(pixels.length);
  // 8-bit input has only 256 distinct values per channel: the transfer function and the matrix are
  // the expensive part, so the encode side is tabulated and the decode side looked up.
  const decode = new Float64Array(256);
  for (let value = 0; value < 256; value += 1) decode[value] = toLinear(value / 255, source.transfer);
  for (let index = 0; index < pixels.length; index += 4) {
    const r = decode[pixels[index]!]!, g = decode[pixels[index + 1]!]!, b = decode[pixels[index + 2]!]!;
    const lr = m[0] * r + m[1] * g + m[2] * b;
    const lg = m[3] * r + m[4] * g + m[5] * b;
    const lb = m[6] * r + m[7] * g + m[8] * b;
    output[index] = fromLinear(Math.min(1, Math.max(0, lr)), destination.transfer) * 255;
    output[index + 1] = fromLinear(Math.min(1, Math.max(0, lg)), destination.transfer) * 255;
    output[index + 2] = fromLinear(Math.min(1, Math.max(0, lb)), destination.transfer) * 255;
    output[index + 3] = pixels[index + 3]!;
  }
  return output;
}
