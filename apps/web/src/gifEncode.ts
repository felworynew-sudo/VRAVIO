/**
 * GIF89a encoder. Browsers' `canvas.toBlob` has no GIF encoder at all, so unlike
 * every other export format in `exportImage.ts` this is written from scratch —
 * ported from Patchy's `formats/gif_document_io.cpp` (LZW bit-packing, GIF89a
 * structure, transparency via the graphic control extension) since a hand-rolled
 * LZW is exactly the kind of code that looks right and silently isn't.
 */

const GIF_TRAILER = 0x3b;

class ByteWriter {
  private bytes: number[] = [];
  u8(value: number): void { this.bytes.push(value & 0xff); }
  u16(value: number): void { this.bytes.push(value & 0xff, (value >> 8) & 0xff); }
  bytesRaw(values: ArrayLike<number>): void { for (let i = 0; i < values.length; i += 1) this.bytes.push(values[i]! & 0xff); }
  ascii(text: string): void { for (const char of text) this.bytes.push(char.charCodeAt(0)); }
  toUint8Array(): Uint8Array<ArrayBuffer> { return Uint8Array.from(this.bytes); }
}

/** LZW code stream packed LSB-first into 255-byte sub-blocks, matching Patchy's `SubBlockBitWriter`. */
class SubBlockBitWriter {
  private block: number[] = [];
  private bitBuffer = 0;
  private bitCount = 0;
  constructor(private readonly out: ByteWriter) {}

  writeCode(code: number, width: number): void {
    this.bitBuffer |= code << this.bitCount;
    this.bitCount += width;
    while (this.bitCount >= 8) {
      this.pushByte(this.bitBuffer & 0xff);
      this.bitBuffer >>>= 8;
      this.bitCount -= 8;
    }
  }

  finish(): void {
    if (this.bitCount > 0) { this.pushByte(this.bitBuffer & 0xff); this.bitBuffer = 0; this.bitCount = 0; }
    this.flushBlock();
    this.out.u8(0);
  }

  private pushByte(byte: number): void {
    this.block.push(byte);
    if (this.block.length === 255) this.flushBlock();
  }

  private flushBlock(): void {
    if (this.block.length === 0) return;
    this.out.u8(this.block.length);
    this.out.bytesRaw(this.block);
    this.block = [];
  }
}

function colorTableSizeBits(paletteSize: number): number {
  let bits = 1;
  while ((1 << bits) < paletteSize) bits += 1;
  return Math.max(1, bits);
}

/** Padded with black to the declared power-of-two entry count, same as Patchy's `write_color_table`. */
function writeColorTable(writer: ByteWriter, palette: readonly (readonly [number, number, number])[], sizeBits: number): void {
  const entries = 1 << sizeBits;
  for (let i = 0; i < entries; i += 1) {
    const color = palette[i];
    writer.u8(color?.[0] ?? 0); writer.u8(color?.[1] ?? 0); writer.u8(color?.[2] ?? 0);
  }
}

function encodeLzw(out: ByteWriter, indexes: Uint8Array, minCodeSize: number): void {
  const bits = new SubBlockBitWriter(out);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let dictionary = new Map<number, number>();
  let nextCode = clearCode + 2;
  let codeWidth = minCodeSize + 1;
  const resetDictionary = () => { dictionary = new Map<number, number>(); nextCode = clearCode + 2; codeWidth = minCodeSize + 1; };

  bits.writeCode(clearCode, codeWidth);
  if (indexes.length === 0) { bits.writeCode(endCode, codeWidth); bits.finish(); return; }

  let prefix = indexes[0]!;
  for (let i = 1; i < indexes.length; i += 1) {
    const symbol = indexes[i]!;
    const key = (prefix << 8) | symbol;
    const found = dictionary.get(key);
    if (found !== undefined) { prefix = found; continue; }
    bits.writeCode(prefix, codeWidth);
    // A decoder assigns its matching entry one code LATER than the encoder (it needs the next
    // code's first symbol), so it grows the code width when ITS next slot hits 2^width — exactly
    // when the value just assigned here equals 2^width. Checking after the increment desyncs by
    // one entry (verified against Patchy's own comment, cross-checked against the GIF spec).
    dictionary.set(key, nextCode);
    if (nextCode === 1 << codeWidth && codeWidth < 12) codeWidth += 1;
    nextCode += 1;
    if (nextCode >= 4096) { bits.writeCode(clearCode, codeWidth); resetDictionary(); }
    prefix = symbol;
  }
  bits.writeCode(prefix, codeWidth);
  bits.writeCode(endCode, codeWidth);
  bits.finish();
}

// --- Median-cut palette quantization -------------------------------------------------------

interface HistogramEntry { r: number; g: number; b: number; count: number; }

function buildHistogram(rgba: Uint8ClampedArray, alphaThreshold: number): { entries: HistogramEntry[]; hasTransparency: boolean } {
  const counts = new Map<number, HistogramEntry>();
  let hasTransparency = false;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]! < alphaThreshold) { hasTransparency = true; continue; }
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    const key = (r << 16) | (g << 8) | b;
    const existing = counts.get(key);
    if (existing) existing.count += 1; else counts.set(key, { r, g, b, count: 1 });
  }
  return { entries: [...counts.values()], hasTransparency };
}

function channelRange(box: readonly HistogramEntry[]): { channel: "r" | "g" | "b"; size: number } {
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  for (const entry of box) {
    if (entry.r < minR) minR = entry.r; if (entry.r > maxR) maxR = entry.r;
    if (entry.g < minG) minG = entry.g; if (entry.g > maxG) maxG = entry.g;
    if (entry.b < minB) minB = entry.b; if (entry.b > maxB) maxB = entry.b;
  }
  const ranges = { r: maxR - minR, g: maxG - minG, b: maxB - minB };
  const channel = (Object.keys(ranges) as (keyof typeof ranges)[]).reduce((best, key) => ranges[key] > ranges[best] ? key : best, "r" as keyof typeof ranges);
  return { channel, size: ranges[channel] };
}

function medianCutBoxes(entries: HistogramEntry[], maxColors: number): HistogramEntry[][] {
  if (entries.length === 0) return [];
  const boxes: HistogramEntry[][] = [entries];
  while (boxes.length < maxColors) {
    let splitIndex = -1, bestScore = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i]!;
      if (box.length < 2) continue;
      const total = box.reduce((sum, entry) => sum + entry.count, 0);
      const score = channelRange(box).size * total;
      if (score > bestScore) { bestScore = score; splitIndex = i; }
    }
    if (splitIndex === -1) break;
    const box = boxes[splitIndex]!;
    const { channel } = channelRange(box);
    box.sort((a, b) => a[channel] - b[channel]);
    const total = box.reduce((sum, entry) => sum + entry.count, 0);
    let accumulated = 0, cut = 1;
    for (let i = 0; i < box.length; i += 1) {
      accumulated += box[i]!.count;
      if (accumulated >= total / 2) { cut = Math.max(1, i + 1); break; }
    }
    const left = box.slice(0, cut), right = box.slice(cut);
    if (right.length === 0) break;
    boxes.splice(splitIndex, 1, left, right);
  }
  return boxes;
}

function boxAverageColor(box: readonly HistogramEntry[]): readonly [number, number, number] {
  let r = 0, g = 0, b = 0, total = 0;
  for (const entry of box) { r += entry.r * entry.count; g += entry.g * entry.count; b += entry.b * entry.count; total += entry.count; }
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
}

const LUT_GRID = 32;
const LUT_STEP = 256 / LUT_GRID;

/** Approximate nearest-palette-color lookup, precomputed on a 32-level-per-channel grid — an
 * exhaustive per-pixel search over up to 256 colors is O(width * height * 256), too slow for a
 * multi-megapixel canvas; this bounds the one-time setup cost to 32³ × 256 instead. */
function buildNearestLut(palette: readonly (readonly [number, number, number])[]): Uint8Array {
  const lut = new Uint8Array(LUT_GRID * LUT_GRID * LUT_GRID);
  for (let ri = 0; ri < LUT_GRID; ri += 1) for (let gi = 0; gi < LUT_GRID; gi += 1) for (let bi = 0; bi < LUT_GRID; bi += 1) {
    const r = ri * LUT_STEP + LUT_STEP / 2, g = gi * LUT_STEP + LUT_STEP / 2, b = bi * LUT_STEP + LUT_STEP / 2;
    let best = 0, bestDistance = Infinity;
    for (let p = 0; p < palette.length; p += 1) {
      const [pr, pg, pb] = palette[p]!;
      const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = p; }
    }
    lut[(ri * LUT_GRID + gi) * LUT_GRID + bi] = best;
  }
  return lut;
}

function lutIndex(lut: Uint8Array, r: number, g: number, b: number): number {
  const bucket = (value: number) => Math.max(0, Math.min(LUT_GRID - 1, Math.floor(value / LUT_STEP)));
  return lut[(bucket(r) * LUT_GRID + bucket(g)) * LUT_GRID + bucket(b)]!;
}

export interface GifQuantizeResult {
  readonly palette: readonly (readonly [number, number, number])[];
  readonly indexes: Uint8Array;
  readonly transparentIndex: number;
}

/**
 * Builds a ≤256-color palette (median cut) and an index buffer for `rgba`. Pixels below
 * `alphaThreshold` become one reserved transparent index — GIF has no partial alpha, only a
 * single fully-transparent palette entry, so the alpha channel is a hard cutoff, not a blend.
 */
export function quantizeForGif(rgba: Uint8ClampedArray, width: number, height: number, maxColors: number, dither: boolean, alphaThreshold = 128): GifQuantizeResult {
  const clampedMax = Math.max(2, Math.min(256, Math.round(maxColors)));
  const { entries, hasTransparency } = buildHistogram(rgba, alphaThreshold);
  const colorBudget = hasTransparency ? clampedMax - 1 : clampedMax;
  const boxes = medianCutBoxes(entries, Math.max(1, colorBudget));
  const palette = boxes.map(boxAverageColor);
  const transparentIndex = hasTransparency ? palette.length : -1;
  const lut = palette.length > 0 ? buildNearestLut(palette) : new Uint8Array(0);

  const indexes = new Uint8Array(width * height);
  const errorR = dither ? new Float32Array(width * height) : null;
  const errorG = dither ? new Float32Array(width * height) : null;
  const errorB = dither ? new Float32Array(width * height) : null;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const pixel = y * width + x, source = pixel * 4;
    if (rgba[source + 3]! < alphaThreshold) { indexes[pixel] = transparentIndex >= 0 ? transparentIndex : 0; continue; }
    const r = Math.max(0, Math.min(255, rgba[source]! + (errorR?.[pixel] ?? 0)));
    const g = Math.max(0, Math.min(255, rgba[source + 1]! + (errorG?.[pixel] ?? 0)));
    const b = Math.max(0, Math.min(255, rgba[source + 2]! + (errorB?.[pixel] ?? 0)));
    const index = palette.length > 0 ? lutIndex(lut, r, g, b) : 0;
    indexes[pixel] = index;
    if (errorR && errorG && errorB) {
      const [pr, pg, pb] = palette[index]!;
      const dr = r - pr, dg = g - pg, db = b - pb;
      const spread = (channel: Float32Array, amount: number, dx: number, dy: number) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        channel[ny * width + nx]! += amount;
      };
      spread(errorR, dr * 7 / 16, 1, 0); spread(errorG, dg * 7 / 16, 1, 0); spread(errorB, db * 7 / 16, 1, 0);
      spread(errorR, dr * 3 / 16, -1, 1); spread(errorG, dg * 3 / 16, -1, 1); spread(errorB, db * 3 / 16, -1, 1);
      spread(errorR, dr * 5 / 16, 0, 1); spread(errorG, dg * 5 / 16, 0, 1); spread(errorB, db * 5 / 16, 0, 1);
      spread(errorR, dr * 1 / 16, 1, 1); spread(errorG, dg * 1 / 16, 1, 1); spread(errorB, db * 1 / 16, 1, 1);
    }
  }
  const paletteWithTransparentSlot = transparentIndex >= 0 ? [...palette, [0, 0, 0] as const] : palette;
  return { palette: paletteWithTransparentSlot, indexes, transparentIndex };
}

export function encodeGifPixels(width: number, height: number, palette: readonly (readonly [number, number, number])[], indexes: Uint8Array, transparentIndex: number): Blob {
  if (width <= 0 || height <= 0 || width > 0xffff || height > 0xffff) throw new RangeError("GIF dimensions must be between 1 and 65535");
  const paletteForTable = palette.length > 0 ? palette : [[0, 0, 0] as const];
  const sizeBits = colorTableSizeBits(paletteForTable.length);

  const writer = new ByteWriter();
  writer.ascii("GIF89a");
  writer.u16(width); writer.u16(height);
  writer.u8(0x80 | 0x70 | (sizeBits - 1));
  writer.u8(0); // background color index
  writer.u8(0); // pixel aspect ratio
  writeColorTable(writer, paletteForTable, sizeBits);
  if (transparentIndex >= 0) {
    writer.u8(0x21); writer.u8(0xf9); writer.u8(4);
    writer.u8(0x01); // transparency flag
    writer.u16(0); // delay
    writer.u8(transparentIndex);
    writer.u8(0);
  }
  writer.u8(0x2c); // image descriptor
  writer.u16(0); writer.u16(0); writer.u16(width); writer.u16(height);
  writer.u8(0); // no local table, not interlaced

  const minCodeSize = Math.max(2, sizeBits);
  writer.u8(minCodeSize);
  encodeLzw(writer, indexes, minCodeSize);
  writer.u8(GIF_TRAILER);
  return new Blob([writer.toUint8Array()], { type: "image/gif" });
}

export function encodeGif(canvas: HTMLCanvasElement, maxColors: number, dither: boolean): Blob {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const { palette, indexes, transparentIndex } = quantizeForGif(data, canvas.width, canvas.height, maxColors, dither);
  return encodeGifPixels(canvas.width, canvas.height, palette, indexes, transparentIndex);
}
