/**
 * Putting an ICC profile into an encoded image, and taking one back out (master-plan §59.3).
 *
 * The browser's own `canvas.toBlob` writes no profile at all: every PNG and JPEG this editor
 * exported claimed nothing, and every viewer assumed sRGB — which is wrong for a Display P3 or
 * Adobe RGB document and is exactly the "the numbers mean something else now" failure colour
 * management exists to prevent. The container formats each carry a profile in their own way, and
 * all three are small, well-specified insertions rather than a re-encode:
 *
 *   - PNG: an `iCCP` chunk (name, 0, compression method 0, zlib-deflated profile) placed before
 *     `IDAT`, per the PNG spec. Deflate comes from the platform's own `CompressionStream("deflate")`,
 *     which emits exactly the zlib wrapper PNG wants — no bundled compressor.
 *   - JPEG: an `APP2` segment starting `ICC_PROFILE\0`, with a 1-based chunk number and count, so
 *     profiles larger than 65 533 bytes span several segments (ours do not, but the reader must
 *     still be written for it).
 *   - TIFF: tag 34675 (`InterColorProfile`), which this project writes its own encoder for, so the
 *     profile is added as one more IFD entry rather than patched in afterwards.
 *
 * Every function here works on bytes and leaves the pixels alone: embedding a profile must never
 * change a single pixel, only what the file says those pixels mean.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const isPng = (bytes: Uint8Array): boolean => PNG_SIGNATURE.every((value, index) => bytes[index] === value);
const isJpeg = (bytes: Uint8Array): boolean => bytes[0] === 0xff && bytes[1] === 0xd8;

/** The PNG bytes with an `iCCP` chunk inserted before the first `IDAT`, replacing any existing one. */
export async function embedIccInPng(png: Uint8Array, profile: Uint8Array, name = "VRAVIO"): Promise<Uint8Array> {
  if (!isPng(png)) return png;
  const compressed = await deflate(profile);
  const nameBytes = new TextEncoder().encode(name.slice(0, 79));
  const payload = new Uint8Array(nameBytes.length + 2 + compressed.length);
  payload.set(nameBytes, 0);
  payload[nameBytes.length] = 0;              // null terminator
  payload[nameBytes.length + 1] = 0;          // compression method: zlib deflate, the only one
  payload.set(compressed, nameBytes.length + 2);

  const chunk = new Uint8Array(12 + payload.length);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, payload.length);
  chunk.set(new TextEncoder().encode("iCCP"), 4);
  chunk.set(payload, 8);
  chunkView.setUint32(8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)));

  // Walk the chunks rather than searching for bytes: "IDAT" can occur inside compressed data.
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const output: Uint8Array[] = [png.subarray(0, 8)];
  let cursor = 8, inserted = false;
  while (cursor + 8 <= png.length) {
    const length = view.getUint32(cursor);
    const type = String.fromCharCode(png[cursor + 4]!, png[cursor + 5]!, png[cursor + 6]!, png[cursor + 7]!);
    const end = cursor + 12 + length;
    if (!inserted && (type === "IDAT" || type === "IEND")) { output.push(chunk); inserted = true; }
    // The browser's own encoder writes `sRGB` (and often `gAMA`/`cHRM`) into every PNG it makes.
    // Left in place beside an iCCP chunk for a wider space they would contradict it — the PNG spec
    // says iCCP wins, but a file that says two different things is a file some reader gets wrong.
    // Found live: a Display P3 export carried Chrome's sRGB tagging as well as ours.
    if (type !== "iCCP" && type !== "sRGB" && type !== "gAMA" && type !== "cHRM") output.push(png.subarray(cursor, end));
    cursor = end;
  }
  if (!inserted) output.push(chunk);
  const total = output.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of output) { result.set(part, offset); offset += part.length; }
  return result;
}

/** The JPEG bytes with `APP2`/`ICC_PROFILE` segments inserted right after `SOI`. */
export function embedIccInJpeg(jpeg: Uint8Array, profile: Uint8Array): Uint8Array {
  if (!isJpeg(jpeg)) return jpeg;
  // Chrome's JPEG encoder embeds its own sRGB profile. Two ICC_PROFILE segments in one file is
  // not a merge, it is a contradiction — and the reader below, keyed by the chunk numbers both
  // claim, would hand back whichever came last. Found live on a Display P3 export.
  jpeg = stripJpegIcc(jpeg);
  const header = new TextEncoder().encode("ICC_PROFILE\0");
  const maximum = 65533 - header.length - 2;
  const count = Math.max(1, Math.ceil(profile.length / maximum));
  const segments: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const slice = profile.subarray(index * maximum, Math.min(profile.length, (index + 1) * maximum));
    const segment = new Uint8Array(4 + header.length + 2 + slice.length);
    segment[0] = 0xff; segment[1] = 0xe2;
    new DataView(segment.buffer).setUint16(2, segment.length - 2);
    segment.set(header, 4);
    segment[4 + header.length] = index + 1;   // chunk numbers are 1-based
    segment[5 + header.length] = count;
    segment.set(slice, 6 + header.length);
    segments.push(segment);
  }
  const total = jpeg.length + segments.reduce((sum, segment) => sum + segment.length, 0);
  const result = new Uint8Array(total);
  result.set(jpeg.subarray(0, 2), 0);
  let offset = 2;
  for (const segment of segments) { result.set(segment, offset); offset += segment.length; }
  result.set(jpeg.subarray(2), offset);
  return result;
}

/** The same JPEG without any `APP2`/`ICC_PROFILE` segment it already had. */
function stripJpegIcc(jpeg: Uint8Array): Uint8Array {
  const header = "ICC_PROFILE\0";
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  const keep: Uint8Array[] = [jpeg.subarray(0, 2)];
  let cursor = 2, removed = false;
  while (cursor + 4 <= jpeg.length) {
    if (jpeg[cursor] !== 0xff) break;
    const marker = jpeg[cursor + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { keep.push(jpeg.subarray(cursor, cursor + 2)); cursor += 2; continue; }
    const length = view.getUint16(cursor + 2);
    const segment = jpeg.subarray(cursor, cursor + 2 + length);
    const isIcc = marker === 0xe2 && String.fromCharCode(...segment.subarray(4, 4 + header.length)) === header;
    if (isIcc) removed = true; else keep.push(segment);
    cursor += 2 + length;
  }
  if (!removed) return jpeg;
  keep.push(jpeg.subarray(cursor));
  const total = keep.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of keep) { result.set(part, offset); offset += part.length; }
  return result;
}

/** The profile carried by a PNG or JPEG, or null when it carries none. */
export async function readEmbeddedIcc(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (isPng(bytes)) return readPngIcc(bytes);
  if (isJpeg(bytes)) return readJpegIcc(bytes);
  return null;
}

async function readPngIcc(png: Uint8Array): Promise<Uint8Array | null> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let cursor = 8;
  while (cursor + 8 <= png.length) {
    const length = view.getUint32(cursor);
    const type = String.fromCharCode(png[cursor + 4]!, png[cursor + 5]!, png[cursor + 6]!, png[cursor + 7]!);
    if (type === "iCCP") {
      const payload = png.subarray(cursor + 8, cursor + 8 + length);
      const nameEnd = payload.indexOf(0);
      if (nameEnd < 0) return null;
      const compressed = payload.subarray(nameEnd + 2);
      try {
        const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch { return null; }
    }
    if (type === "IDAT") return null;   // profiles live before the image data
    cursor += 12 + length;
  }
  return null;
}

function readJpegIcc(jpeg: Uint8Array): Uint8Array | null {
  const header = "ICC_PROFILE\0";
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  const parts = new Map<number, Uint8Array>();
  let cursor = 2;
  while (cursor + 4 <= jpeg.length) {
    if (jpeg[cursor] !== 0xff) break;
    const marker = jpeg[cursor + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { cursor += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;                     // scan data begins; no more headers
    const length = view.getUint16(cursor + 2);
    if (marker === 0xe2) {
      const segment = jpeg.subarray(cursor + 4, cursor + 2 + length);
      const text = String.fromCharCode(...segment.subarray(0, header.length));
      if (text === header) parts.set(segment[header.length]!, segment.subarray(header.length + 2));
    }
    cursor += 2 + length;
  }
  if (!parts.size) return null;
  const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part);
  const total = ordered.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of ordered) { result.set(part, offset); offset += part.length; }
  return result;
}
