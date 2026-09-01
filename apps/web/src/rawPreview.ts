/**
 * RAW camera files (CR2/NEF/ARW/DNG/ORF/PEF/RW2) are TIFF containers that carry one or more
 * full-resolution JPEG previews alongside the undeveloped sensor data. Browsers cannot demosaic
 * the sensor data, so this extracts the largest embedded JPEG preview instead of decoding raw
 * pixels. It is a real preview, not a full RAW develop (no white balance, no demosaic, no highlight
 * recovery) — callers must label it as such rather than implying full RAW support.
 */

interface JpegSpan { offset: number; length: number }

function readIfd(view: DataView, offset: number, littleEndian: boolean, results: JpegSpan[], seen: Set<number>): void {
  if (offset <= 0 || seen.has(offset) || offset + 2 > view.byteLength) return;
  seen.add(offset);
  const entryCount = view.getUint16(offset, littleEndian);
  let jpegOffset = -1, jpegLength = -1;
  const subIfdOffsets: number[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = offset + 2 + index * 12;
    if (entryOffset + 12 > view.byteLength) break;
    const tag = view.getUint16(entryOffset, littleEndian), type = view.getUint16(entryOffset + 2, littleEndian), count = view.getUint32(entryOffset + 4, littleEndian), valueOffset = entryOffset + 8;
    const readInline = () => (type === 4 ? view.getUint32(valueOffset, littleEndian) : type === 3 ? view.getUint16(valueOffset, littleEndian) : -1);
    if (tag === 0x0201) jpegOffset = readInline();
    else if (tag === 0x0202) jpegLength = readInline();
    else if (tag === 0x014a || tag === 0x8769) {
      if (count === 1) subIfdOffsets.push(readInline());
      else { const arrayOffset = view.getUint32(valueOffset, littleEndian); for (let k = 0; k < count; k += 1) if (arrayOffset + k * 4 + 4 <= view.byteLength) subIfdOffsets.push(view.getUint32(arrayOffset + k * 4, littleEndian)); }
    }
  }
  if (jpegOffset > 0 && jpegLength > 0 && jpegOffset + jpegLength <= view.byteLength) results.push({ offset: jpegOffset, length: jpegLength });
  for (const sub of subIfdOffsets) readIfd(view, sub, littleEndian, results, seen);
  const nextPointer = offset + 2 + entryCount * 12;
  if (nextPointer + 4 <= view.byteLength) { const next = view.getUint32(nextPointer, littleEndian); if (next) readIfd(view, next, littleEndian, results, seen); }
}

/** Returns the bytes of the largest embedded JPEG preview, or null if this isn't a readable TIFF-based RAW file. */
export function extractRawPreviewJpeg(buffer: ArrayBuffer): Uint8Array | null {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const b0 = view.getUint8(0), b1 = view.getUint8(1), littleEndian = b0 === 0x49 && b1 === 0x49, bigEndian = b0 === 0x4d && b1 === 0x4d;
  if (!littleEndian && !bigEndian) return null;
  if (view.getUint16(2, littleEndian) !== 42) return null;
  const results: JpegSpan[] = [];
  readIfd(view, view.getUint32(4, littleEndian), littleEndian, results, new Set());
  if (!results.length) return null;
  const best = results.reduce((a, b) => (b.length > a.length ? b : a));
  return new Uint8Array(buffer, best.offset, best.length);
}
