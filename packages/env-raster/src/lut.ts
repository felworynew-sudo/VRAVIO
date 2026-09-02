/**
 * 3D colour lookup tables — the data behind a Color Lookup adjustment layer.
 *
 * Stored the way `.cube` files store them: RGB triples in 0..1 with the red index varying
 * fastest, so a parsed file can be used without reordering.
 */
export interface ColorLookupTable {
  readonly title: string;
  /** Edge length of the cube; a 33×33×33 table has size 33. */
  readonly size: number;
  /** `size³ × 3` values in 0..1. */
  readonly data: Float32Array;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
}

const DEFAULT_MIN: readonly [number, number, number] = [0, 0, 0];
const DEFAULT_MAX: readonly [number, number, number] = [1, 1, 1];

export function identityLut(size = 8, title = "Identity (Без изменений)"): ColorLookupTable {
  const data = new Float32Array(size * size * size * 3);
  const last = Math.max(1, size - 1);
  for (let blue = 0; blue < size; blue += 1) for (let green = 0; green < size; green += 1) for (let red = 0; red < size; red += 1) {
    const index = (red + green * size + blue * size * size) * 3;
    data[index] = red / last;
    data[index + 1] = green / last;
    data[index + 2] = blue / last;
  }
  return { title, size, data, domainMin: DEFAULT_MIN, domainMax: DEFAULT_MAX };
}

/** Builds a cube by evaluating a colour transform at every lattice point. */
export function generateLut(title: string, size: number, transform: (r: number, g: number, b: number) => [number, number, number]): ColorLookupTable {
  const cube = identityLut(size, title);
  const data = new Float32Array(cube.data.length);
  const last = Math.max(1, size - 1);
  for (let blue = 0; blue < size; blue += 1) for (let green = 0; green < size; green += 1) for (let red = 0; red < size; red += 1) {
    const index = (red + green * size + blue * size * size) * 3;
    const [outR, outG, outB] = transform(red / last, green / last, blue / last);
    data[index] = Math.max(0, Math.min(1, outR));
    data[index + 1] = Math.max(0, Math.min(1, outG));
    data[index + 2] = Math.max(0, Math.min(1, outB));
  }
  return { ...cube, data };
}

const lift = (value: number, gain: number, offset: number) => value * gain + offset;

/**
 * Built-in looks, generated rather than shipped as files so there is something to apply
 * before the user loads a `.cube`. Each is a real 3D table, not a per-channel curve.
 */
export const builtInLuts: readonly ColorLookupTable[] = [
  generateLut("Warm (Тёплый)", 17, (r, g, b) => [lift(r, 1.06, .03), lift(g, 1.01, .01), lift(b, .92, -.02)]),
  generateLut("Cool (Холодный)", 17, (r, g, b) => [lift(r, .92, -.01), lift(g, .99, .01), lift(b, 1.08, .04)]),
  generateLut("Teal & Orange (Бирюза и апельсин)", 17, (r, g, b) => {
    const luma = r * .3 + g * .59 + b * .11;
    // Push shadows toward teal and highlights toward orange, the standard cinema grade.
    const weight = luma - .5;
    return [r + weight * .16, g + weight * .04, b - weight * .18];
  }),
  generateLut("Bleach Bypass (Отбеливание)", 17, (r, g, b) => {
    const luma = r * .3 + g * .59 + b * .11;
    return [r * .45 + luma * .65, g * .45 + luma * .65, b * .45 + luma * .65];
  }),
];

/** Parses an Adobe/IRIDAS `.cube` file. Only 3D tables are supported; 1D files are rejected. */
export function parseCubeLut(text: string, fallbackTitle = "LUT"): ColorLookupTable {
  let size = 0, title = fallbackTitle;
  let domainMin: [number, number, number] = [...DEFAULT_MIN] as [number, number, number];
  let domainMax: [number, number, number] = [...DEFAULT_MAX] as [number, number, number];
  const values: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("TITLE")) { title = line.slice(5).trim().replace(/^"|"$/g, "") || fallbackTitle; continue; }
    if (upper.startsWith("LUT_3D_SIZE")) { size = Number.parseInt(line.split(/\s+/)[1] ?? "", 10); continue; }
    if (upper.startsWith("LUT_1D_SIZE")) throw new Error("1D .cube files are not supported");
    if (upper.startsWith("DOMAIN_MIN")) { domainMin = triple(line) ?? domainMin; continue; }
    if (upper.startsWith("DOMAIN_MAX")) { domainMax = triple(line) ?? domainMax; continue; }
    if (/^[-+.\d]/.test(line)) {
      const parts = line.split(/\s+/).map(Number);
      if (parts.length >= 3 && parts.every(Number.isFinite)) values.push(parts[0]!, parts[1]!, parts[2]!);
    }
  }

  if (!Number.isInteger(size) || size < 2) throw new Error("Missing or invalid LUT_3D_SIZE");
  const expected = size * size * size * 3;
  if (values.length !== expected) throw new Error(`Expected ${expected / 3} entries, found ${values.length / 3}`);
  return { title, size, data: Float32Array.from(values), domainMin, domainMax };
}

function triple(line: string): [number, number, number] | null {
  const parts = line.split(/\s+/).slice(1).map(Number);
  return parts.length >= 3 && parts.every(Number.isFinite) ? [parts[0]!, parts[1]!, parts[2]!] : null;
}

/** Serializes back to `.cube`, so a look built in the app can leave it. */
export function formatCubeLut(lut: ColorLookupTable): string {
  const lines = [`TITLE "${lut.title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${lut.size}`, `DOMAIN_MIN ${lut.domainMin.join(" ")}`, `DOMAIN_MAX ${lut.domainMax.join(" ")}`, ""];
  for (let index = 0; index < lut.data.length; index += 3) {
    lines.push(`${lut.data[index]!.toFixed(6)} ${lut.data[index + 1]!.toFixed(6)} ${lut.data[index + 2]!.toFixed(6)}`);
  }
  return lines.join("\n");
}

/**
 * Trilinear sample of the cube for one 8-bit colour.
 *
 * Nearest-neighbour lookup is visibly banded on the small tables most looks ship as, so the
 * eight surrounding lattice points are blended.
 */
export function sampleColorLookup(lut: ColorLookupTable, r: number, g: number, b: number): [number, number, number] {
  const last = lut.size - 1;
  const axis = (value: number, index: number): number => {
    const min = lut.domainMin[index] ?? 0, max = lut.domainMax[index] ?? 1;
    const normalized = (value / 255 - min) / Math.max(1e-6, max - min);
    return Math.max(0, Math.min(last, normalized * last));
  };
  const x = axis(r, 0), y = axis(g, 1), z = axis(b, 2);
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(last, x0 + 1), y1 = Math.min(last, y0 + 1), z1 = Math.min(last, z0 + 1);
  const fx = x - x0, fy = y - y0, fz = z - z0;

  const at = (xi: number, yi: number, zi: number, channel: number): number =>
    lut.data[(xi + yi * lut.size + zi * lut.size * lut.size) * 3 + channel]!;

  const channel = (index: number): number => {
    const c00 = at(x0, y0, z0, index) * (1 - fx) + at(x1, y0, z0, index) * fx;
    const c10 = at(x0, y1, z0, index) * (1 - fx) + at(x1, y1, z0, index) * fx;
    const c01 = at(x0, y0, z1, index) * (1 - fx) + at(x1, y0, z1, index) * fx;
    const c11 = at(x0, y1, z1, index) * (1 - fx) + at(x1, y1, z1, index) * fx;
    return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  };

  return [channel(0) * 255, channel(1) * 255, channel(2) * 255];
}
