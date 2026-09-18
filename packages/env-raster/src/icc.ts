import { adaptation, multiplyMatrix, rasterColorSpaceById, rasterColorSpaces, rgbToXyzMatrix, toLinear, type Matrix, type RasterColorSpace, type RasterColorSpaceInfo } from "./color-space";

/**
 * ICC profiles: writing one for a document's working space, and reading one out of a file.
 *
 * Why write our own instead of shipping lcms in WASM (docs/master-plan.md §59.3): the profiles this
 * editor needs to *emit* are matrix/TRC RGB profiles, which the ICC v2 spec describes in about a
 * page — a fixed header, a tag table, three XYZ columns, three tone curves. That is a few hundred
 * lines and no megabyte of WASM on every page load. Reading is the same shape in reverse, plus an
 * honest admission when a file carries something this parser does not model (a LUT-based profile, a
 * CMYK profile): those are reported as unsupported rather than silently approximated.
 *
 * The PCS is D50, as ICC requires: the matrix columns are Bradford-adapted from the space's own
 * white point, which is what `adaptation` already does for conversions between working spaces.
 */

const signature = (text: string): number => (text.charCodeAt(0) << 24 | text.charCodeAt(1) << 16 | text.charCodeAt(2) << 8 | text.charCodeAt(3)) >>> 0;

/** ICC s15Fixed16: a signed 16.16 fixed-point number. */
const toS15Fixed16 = (value: number): number => Math.round(value * 65536);
const fromS15Fixed16 = (value: number): number => value / 65536;

const D50_XYZ: readonly [number, number, number] = [0.9642, 1, 0.8249];

/** How finely a tone curve is sampled into a `curv` tag. 1024 points reproduce sRGB's piecewise
 *  curve to well under a 16-bit step, and every reader interpolates between them. */
const TRC_POINTS = 1024;

function curveTag(space: RasterColorSpaceInfo): Uint8Array {
  const bytes = new Uint8Array(12 + TRC_POINTS * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature("curv"));
  view.setUint32(8, TRC_POINTS);
  for (let index = 0; index < TRC_POINTS; index += 1) {
    const linear = toLinear(index / (TRC_POINTS - 1), space.transfer);
    view.setUint16(12 + index * 2, Math.max(0, Math.min(65535, Math.round(linear * 65535))));
  }
  return bytes;
}

function xyzTag(x: number, y: number, z: number): Uint8Array {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature("XYZ "));
  view.setInt32(8, toS15Fixed16(x)); view.setInt32(12, toS15Fixed16(y)); view.setInt32(16, toS15Fixed16(z));
  return bytes;
}

/** ICC v2's `desc` tag: an ASCII name, plus the empty Unicode and ScriptCode fields it requires. */
function textDescriptionTag(text: string): Uint8Array {
  const ascii = `${text}\0`;
  const bytes = new Uint8Array(12 + ascii.length + 12 + 2 + 1 + 67);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature("desc"));
  view.setUint32(8, ascii.length);
  for (let index = 0; index < ascii.length; index += 1) bytes[12 + index] = ascii.charCodeAt(index) & 0x7f;
  return bytes;
}

function textTag(text: string): Uint8Array {
  const ascii = `${text}\0`;
  const bytes = new Uint8Array(8 + ascii.length);
  new DataView(bytes.buffer).setUint32(0, signature("text"));
  for (let index = 0; index < ascii.length; index += 1) bytes[8 + index] = ascii.charCodeAt(index) & 0x7f;
  return bytes;
}

/** The space's RGB→XYZ matrix with its white point adapted to the profile connection space (D50). */
export function d50Matrix(space: RasterColorSpaceInfo): Matrix {
  return multiplyMatrix(adaptation(space.whitePoint, [0.34567, 0.35850]), rgbToXyzMatrix(space));
}

/**
 * A complete ICC v2 matrix/TRC profile for one of this editor's working spaces — the bytes that go
 * into a PNG's `iCCP` chunk or a JPEG's APP2 segment so that the exported file says what its numbers
 * mean instead of leaving every viewer to guess sRGB.
 */
export function buildIccProfile(id: RasterColorSpace): Uint8Array {
  const space = rasterColorSpaceById(id) ?? rasterColorSpaces[0]!;
  const matrix = d50Matrix(space);
  const trc = curveTag(space);
  const tags: Array<{ signature: string; data: Uint8Array }> = [
    { signature: "desc", data: textDescriptionTag(space.label.en) },
    { signature: "wtpt", data: xyzTag(D50_XYZ[0], D50_XYZ[1], D50_XYZ[2]) },
    { signature: "rXYZ", data: xyzTag(matrix[0], matrix[3], matrix[6]) },
    { signature: "gXYZ", data: xyzTag(matrix[1], matrix[4], matrix[7]) },
    { signature: "bXYZ", data: xyzTag(matrix[2], matrix[5], matrix[8]) },
    { signature: "rTRC", data: trc },
    { signature: "gTRC", data: trc },
    { signature: "bTRC", data: trc },
    { signature: "cprt", data: textTag("Public Domain") },
  ];

  const headerSize = 128, tableSize = 4 + tags.length * 12;
  // Every tag starts on a 4-byte boundary, as the spec requires; the three TRC tags share one
  // block of bytes (they are the same curve), exactly as real profiles do.
  const offsets: number[] = [];
  let cursor = headerSize + tableSize;
  const blocks: Array<{ offset: number; data: Uint8Array }> = [];
  const seen = new Map<Uint8Array, number>();
  for (const tag of tags) {
    const existing = seen.get(tag.data);
    if (existing !== undefined) { offsets.push(existing); continue; }
    const padded = (4 - (cursor % 4)) % 4;
    cursor += padded;
    offsets.push(cursor);
    seen.set(tag.data, cursor);
    blocks.push({ offset: cursor, data: tag.data });
    cursor += tag.data.length;
  }
  const size = cursor + ((4 - (cursor % 4)) % 4);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, size);
  view.setUint32(4, signature("VRAV"));            // preferred CMM
  view.setUint32(8, 0x02100000);                   // ICC version 2.1
  view.setUint32(12, signature("mntr"));           // display device class
  view.setUint32(16, signature("RGB "));
  view.setUint32(20, signature("XYZ "));           // PCS
  view.setUint32(36, signature("acsp"));
  view.setUint32(64, 0);                           // rendering intent: perceptual (0)
  view.setInt32(68, toS15Fixed16(D50_XYZ[0])); view.setInt32(72, toS15Fixed16(D50_XYZ[1])); view.setInt32(76, toS15Fixed16(D50_XYZ[2]));
  view.setUint32(80, signature("VRAV"));           // profile creator

  view.setUint32(headerSize, tags.length);
  tags.forEach((tag, index) => {
    const entry = headerSize + 4 + index * 12;
    view.setUint32(entry, signature(tag.signature));
    view.setUint32(entry + 4, offsets[index]!);
    view.setUint32(entry + 8, tag.data.length);
  });
  for (const block of blocks) bytes.set(block.data, block.offset);
  return bytes;
}

export interface ParsedIccProfile {
  /** The profile's own name, for showing the user what the file actually carried. */
  readonly description: string;
  /** The working space this profile matches, when it matches one of ours closely enough. */
  readonly space: RasterColorSpace | null;
  /** Why it did not match, when it did not — an honest answer beats a silent approximation. */
  readonly unsupported?: string;
}

const readSignature = (view: DataView, offset: number): string =>
  String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

/**
 * Reads a profile far enough to answer the only question the editor has: which working space is
 * this? A matrix/TRC RGB profile answers it directly — its three XYZ columns are the primaries —
 * and anything else (LUT profiles, CMYK, greyscale) says so instead of pretending.
 */
export function parseIccProfile(data: Uint8Array): ParsedIccProfile | null {
  if (data.length < 132) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (readSignature(view, 36) !== "acsp") return null;
  const dataColourSpace = readSignature(view, 16).trim();
  const tagCount = view.getUint32(128);
  if (tagCount > 1024) return null;
  const tags = new Map<string, { offset: number; size: number }>();
  for (let index = 0; index < tagCount; index += 1) {
    const entry = 132 + index * 12;
    if (entry + 12 > data.length) break;
    tags.set(readSignature(view, entry), { offset: view.getUint32(entry + 4), size: view.getUint32(entry + 8) });
  }

  let description = dataColourSpace;
  const descriptionTag = tags.get("desc");
  if (descriptionTag && descriptionTag.offset + 12 <= data.length) {
    const kind = readSignature(view, descriptionTag.offset);
    if (kind === "desc") {
      const length = Math.max(0, Math.min(descriptionTag.size - 12, view.getUint32(descriptionTag.offset + 8) - 1));
      description = String.fromCharCode(...data.subarray(descriptionTag.offset + 12, descriptionTag.offset + 12 + length));
    } else if (kind === "mluc" && descriptionTag.offset + 28 <= data.length) {
      // ICC v4's multi-localised Unicode: first record, UTF-16BE.
      const length = view.getUint32(descriptionTag.offset + 20), offset = descriptionTag.offset + view.getUint32(descriptionTag.offset + 24);
      let text = "";
      for (let index = 0; index + 1 < length && offset + index + 1 < data.length; index += 2) text += String.fromCharCode(view.getUint16(offset + index));
      if (text) description = text.replace(/\0+$/, "");
    }
  }

  if (dataColourSpace !== "RGB") return { description, space: null, unsupported: `${dataColourSpace} profiles are not supported yet` };
  const columns = (["rXYZ", "gXYZ", "bXYZ"] as const).map((name) => {
    const tag = tags.get(name);
    if (!tag || tag.offset + 20 > data.length || readSignature(view, tag.offset) !== "XYZ ") return null;
    return [fromS15Fixed16(view.getInt32(tag.offset + 8)), fromS15Fixed16(view.getInt32(tag.offset + 12)), fromS15Fixed16(view.getInt32(tag.offset + 16))] as const;
  });
  if (columns.some((column) => !column)) return { description, space: null, unsupported: "Only matrix/TRC profiles are read; this one uses lookup tables" };

  // The comparison is on the profile's own ground — each of our spaces, adapted to D50, against the
  // matrix in the file. A profile is "the same space" when every column agrees to 0.002 in XYZ,
  // which separates sRGB, Adobe RGB, Display P3 and ProPhoto comfortably while tolerating the
  // rounding every real-world profile carries.
  for (const candidate of rasterColorSpaces) {
    const matrix = d50Matrix(candidate);
    const expected = [[matrix[0], matrix[3], matrix[6]], [matrix[1], matrix[4], matrix[7]], [matrix[2], matrix[5], matrix[8]]];
    const primariesMatch = expected.every((column, index) => column.every((value, row) => Math.abs(value - columns[index]![row]!) < 0.002));
    if (!primariesMatch) continue;
    const trc = tags.get("rTRC");
    if (trc && trc.offset + 12 <= data.length && !transferMatches(view, data, trc, candidate)) continue;
    return { description, space: candidate.id };
  }
  return { description, space: null, unsupported: "Profile does not match a working space this editor has" };
}

/** Compares the profile's tone curve with a candidate space's transfer function at a few points —
 *  enough to tell sRGB from Linear sRGB, which share their primaries exactly. */
function transferMatches(view: DataView, data: Uint8Array, tag: { offset: number; size: number }, space: RasterColorSpaceInfo): boolean {
  const kind = readSignature(view, tag.offset);
  const sample = (value: number): number | null => {
    if (kind === "curv") {
      const count = view.getUint32(tag.offset + 8);
      if (count === 0) return value;                                  // identity
      if (count === 1) return value ** (view.getUint16(tag.offset + 12) / 256);
      const position = value * (count - 1), low = Math.floor(position), fraction = position - low;
      const at = (index: number) => view.getUint16(tag.offset + 12 + Math.min(count - 1, index) * 2) / 65535;
      return at(low) + (at(low + 1) - at(low)) * fraction;
    }
    if (kind === "para") {
      const type = view.getUint16(tag.offset + 8);
      const parameter = (index: number) => fromS15Fixed16(view.getInt32(tag.offset + 12 + index * 4));
      const g = parameter(0);
      if (type === 0) return value ** g;
      if (type === 3) { const a = parameter(1), b = parameter(2), c = parameter(3), d = parameter(4); return value >= d ? (a * value + b) ** g : c * value; }
      return null;
    }
    return null;
  };
  for (const value of [0.1, 0.35, 0.6, 0.9]) {
    const fromProfile = sample(value);
    if (fromProfile === null) return true;                            // unreadable curve: do not veto on it
    if (Math.abs(fromProfile - toLinear(value, space.transfer)) > 0.02) return false;
  }
  return true;
}
