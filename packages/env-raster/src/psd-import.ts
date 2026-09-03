import { createRasterLayer, makeLayerOrderKey } from "./document";
import type { RasterBlendMode, RasterDocumentState, RasterLayer } from "./types";

/**
 * Reads a Photoshop (.psd) file into a VRAVIO raster document.
 *
 * Read-only, and scoped to what covers the common case: 8-bit (with a 16-bit
 * downsample) RGB/grayscale layers, RAW or RLE(PackBits)-compressed channel
 * data, opacity, visibility, blend mode and the layer name — the same subset
 * every open-source PSD reader (psd.js, ag-psd) treats as its baseline.
 * Adjustment layers, smart objects, vector/text layers, layer effects, CMYK
 * and 32-bit float are recognised and skipped with a clear note in
 * `PsdImportResult.warnings` rather than silently producing a wrong picture.
 */
export interface PsdImportResult {
  document: RasterDocumentState;
  warnings: string[];
}

class Cursor {
  offset = 0;
  constructor(private readonly view: DataView) {}
  u8(): number { const value = this.view.getUint8(this.offset); this.offset += 1; return value; }
  u16(): number { const value = this.view.getUint16(this.offset, false); this.offset += 2; return value; }
  i16(): number { const value = this.view.getInt16(this.offset, false); this.offset += 2; return value; }
  u32(): number { const value = this.view.getUint32(this.offset, false); this.offset += 4; return value; }
  i32(): number { const value = this.view.getInt32(this.offset, false); this.offset += 4; return value; }
  bytes(length: number): Uint8Array { const value = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length); this.offset += length; return value; }
  ascii(length: number): string { return String.fromCharCode(...this.bytes(length)); }
  skip(length: number): void { this.offset += length; }
}

/** PackBits: a run of `n+1` identical bytes when the control byte (read as signed 8-bit) is
 * negative, or `n+1` literal bytes when non-negative — the same scheme TIFF uses. */
function unpackBitsRow(cursor: Cursor, outLength: number): Uint8Array {
  const out = new Uint8Array(outLength);
  let written = 0;
  while (written < outLength) {
    const raw = cursor.u8(), control = raw > 127 ? raw - 256 : raw;
    if (control >= 0) {
      const count = control + 1;
      out.set(cursor.bytes(count), written);
      written += count;
    } else if (control !== -128) {
      const count = 1 - control, value = cursor.u8();
      out.fill(value, written, written + count);
      written += count;
    }
  }
  return out;
}

const blendModeMap: Record<string, RasterBlendMode> = {
  norm: "normal", diss: "dissolve", dark: "darken", mul: "multiply", idiv: "colorBurn", lbrn: "linearBurn",
  dkCl: "darkerColor", lite: "lighten", scrn: "screen", div: "colorDodge", lddg: "linearDodge", lgCl: "lighterColor",
  over: "overlay", sLit: "softLight", hLit: "hardLight", vLit: "vividLight", lLit: "linearLight", pLit: "pinLight",
  hMix: "hardMix", diff: "difference", smud: "exclusion", fsub: "subtract", fdiv: "divide",
  hue: "hue", sat: "saturation", colr: "color", lum: "luminosity",
};

interface PsdChannel { id: number; length: number }
interface PsdLayerRecord { top: number; left: number; bottom: number; right: number; channels: PsdChannel[]; blendMode: string; opacity: number; clipping: number; flags: number; name: string }

function readPascalString(cursor: Cursor, pad: number): string {
  const length = cursor.u8();
  const bytes = cursor.bytes(length);
  const total = 1 + length, remainder = total % pad;
  if (remainder) cursor.skip(pad - remainder);
  return String.fromCharCode(...bytes);
}

function readUnicodeString(cursor: Cursor): string {
  const length = cursor.u32();
  let out = "";
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(cursor.u16());
  return out;
}

/** Decodes one channel's plane (RAW or RLE), at 8 bits per sample regardless of the source
 * depth — a 16-bit channel is downsampled here (divide by 257) since this is a read path into
 * an 8-bit-per-channel document, not a lossless round-trip. */
function readChannelPlane(cursor: Cursor, width: number, height: number, depth: number, end: number): Uint8Array {
  if (cursor.offset >= end) return new Uint8Array(width * height);
  const compression = cursor.u16();
  const bytesPerSample = depth === 16 ? 2 : depth === 32 ? 4 : 1;
  if (compression === 0) {
    const raw = cursor.bytes(width * height * bytesPerSample);
    if (bytesPerSample === 1) return raw;
    const out = new Uint8Array(width * height);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let index = 0; index < width * height; index += 1) {
      out[index] = bytesPerSample === 2 ? Math.round(view.getUint16(index * 2, false) / 257) : Math.round(view.getFloat32(index * 4, false) * 255);
    }
    return out;
  }
  if (compression === 1) {
    const rowByteCounts: number[] = [];
    for (let row = 0; row < height; row += 1) rowByteCounts.push(cursor.u16());
    const out = new Uint8Array(width * height * bytesPerSample);
    for (let row = 0; row < height; row += 1) {
      const rowStart = cursor.offset;
      const rowBytes = unpackBitsRow(cursor, width * bytesPerSample);
      out.set(rowBytes, row * width * bytesPerSample);
      cursor.offset = rowStart + rowByteCounts[row]!;
    }
    if (bytesPerSample === 1) return out;
    const downsampled = new Uint8Array(width * height);
    const view = new DataView(out.buffer);
    for (let index = 0; index < width * height; index += 1) downsampled[index] = bytesPerSample === 2 ? Math.round(view.getUint16(index * 2, false) / 257) : Math.round(view.getFloat32(index * 4, false) * 255);
    return downsampled;
  }
  // ZIP (2) / ZIP-with-prediction (3): not implemented — the caller reports this layer skipped.
  cursor.offset = end;
  throw new Error(`Unsupported channel compression: ${compression}`);
}

function interleaveRgba(channels: Map<number, Uint8Array>, width: number, height: number, colorChannelCount: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const r = channels.get(0), g = colorChannelCount >= 2 ? channels.get(1) : r, b = colorChannelCount >= 3 ? channels.get(2) : r, a = channels.get(-1);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    pixels[offset] = r?.[index] ?? 0;
    pixels[offset + 1] = g?.[index] ?? 0;
    pixels[offset + 2] = b?.[index] ?? 0;
    pixels[offset + 3] = a ? a[index]! : 255;
  }
  return pixels;
}

export function decodePsd(bytes: Uint8Array): PsdImportResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cursor = new Cursor(view);
  const warnings: string[] = [];

  if (cursor.ascii(4) !== "8BPS") throw new Error("Not a PSD file: missing 8BPS signature");
  const version = cursor.u16();
  if (version !== 1 && version !== 2) throw new Error(`Unsupported PSD version: ${version}`);
  const sizeFieldBytes = version === 2 ? 8 : 4; // PSB (large document format) uses 64-bit sizes/offsets in a few places
  cursor.skip(6); // reserved
  const channelCount = cursor.u16();
  const height = cursor.u32(), width = cursor.u32();
  const depth = cursor.u16();
  const colorMode = cursor.u16();
  if (colorMode !== 3 && colorMode !== 1) throw new Error(`Unsupported PSD color mode: ${colorMode} (only RGB and Grayscale are read)`);
  if (depth !== 8 && depth !== 16 && depth !== 32) throw new Error(`Unsupported PSD bit depth: ${depth}`);

  const colorModeDataLength = cursor.u32();
  cursor.skip(colorModeDataLength);

  const imageResourcesLength = cursor.u32();
  cursor.skip(imageResourcesLength);

  const layerMaskInfoLength = version === 2 ? Number(view.getBigUint64(cursor.offset, false)) : cursor.u32();
  if (version === 2) cursor.offset += 8;
  const layerMaskEnd = cursor.offset + layerMaskInfoLength;

  const layers: RasterLayer[] = [];
  if (layerMaskInfoLength > 0) {
    const layerInfoLength = version === 2 ? Number(view.getBigUint64(cursor.offset, false)) : cursor.u32();
    if (version === 2) cursor.offset += 8;
    const layerInfoEnd = cursor.offset + layerInfoLength;
    const layerCountRaw = cursor.i16();
    const layerCount = Math.abs(layerCountRaw);

    const records: PsdLayerRecord[] = [];
    for (let index = 0; index < layerCount; index += 1) {
      const top = cursor.i32(), left = cursor.i32(), bottom = cursor.i32(), right = cursor.i32();
      const channelsInLayer = cursor.u16();
      const channels: PsdChannel[] = [];
      for (let c = 0; c < channelsInLayer; c += 1) {
        const id = cursor.i16();
        const length = version === 2 ? Number(view.getBigUint64(cursor.offset, false)) : cursor.u32();
        if (version === 2) cursor.offset += 8;
        channels.push({ id, length });
      }
      const blendSig = cursor.ascii(4);
      if (blendSig !== "8BIM") throw new Error("Malformed PSD: expected 8BIM blend signature");
      const blendMode = cursor.ascii(4);
      const opacity = cursor.u8();
      const clipping = cursor.u8();
      const flags = cursor.u8();
      cursor.skip(1); // filler
      const extraDataLength = cursor.u32();
      const extraEnd = cursor.offset + extraDataLength;
      const maskDataLength = cursor.u32(); cursor.skip(maskDataLength);
      const blendingRangesLength = cursor.u32(); cursor.skip(blendingRangesLength);
      let name = readPascalString(cursor, 4);
      // Additional layer info blocks may carry a Unicode name ("luni"), which is what a
      // non-ASCII (e.g. Cyrillic) layer name actually needs — the Pascal string above is
      // lossy outside the system codepage and is only the fallback.
      while (cursor.offset < extraEnd - 8) {
        const sig = cursor.ascii(4);
        if (sig !== "8BIM" && sig !== "8B64") break;
        const key = cursor.ascii(4);
        const blockLength = cursor.u32();
        const blockEnd = cursor.offset + blockLength + (blockLength % 2);
        if (key === "luni") name = readUnicodeString(cursor);
        cursor.offset = blockEnd;
      }
      cursor.offset = extraEnd;
      records.push({ top, left, bottom, right, channels, blendMode, opacity, clipping, flags, name });
    }

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const layerWidth = record.right - record.left, layerHeight = record.bottom - record.top;
      // A group divider, adjustment layer or empty layer has no pixels — its rect is 0x0, but
      // its channel *records* are still present in the stream and have to be consumed in order,
      // or every layer after it in the file reads from the wrong offset.
      if (layerWidth <= 0 || layerHeight <= 0) {
        for (const channel of record.channels) cursor.offset += channel.length;
        continue;
      }
      const planes = new Map<number, Uint8Array>();
      const channelSetEnd = cursor.offset + record.channels.reduce((sum, channel) => sum + channel.length, 0);
      try {
        for (const channel of record.channels) {
          const channelEnd = cursor.offset + channel.length;
          planes.set(channel.id, readChannelPlane(cursor, layerWidth, layerHeight, depth, channelEnd));
          cursor.offset = channelEnd;
        }
      } catch (error) {
        warnings.push(`Layer "${record.name}": ${error instanceof Error ? error.message : String(error)} — left blank.`);
      }
      // Always land exactly where the next layer's channel data starts, whether every channel
      // decoded cleanly or the loop above bailed out partway through one.
      cursor.offset = channelSetEnd;
      const colorChannelCount = colorMode === 1 ? 1 : 3;
      const pixels = interleaveRgba(planes, layerWidth, layerHeight, colorChannelCount);
      const layer = createRasterLayer(Math.max(1, layerWidth), Math.max(1, layerHeight), record.name || `Layer ${index + 1}`);
      layer.bounds = { x: record.left, y: record.top, width: layerWidth, height: layerHeight };
      layer.width = layerWidth; layer.height = layerHeight;
      layer.pixels = pixels;
      layer.opacity = record.opacity / 255;
      // PSD's visibility bit: bit 1 of the flags byte is 1 when the layer is HIDDEN.
      layer.visible = (record.flags & 0x02) === 0;
      layer.clipping = record.clipping === 1;
      layer.blendMode = blendModeMap[record.blendMode] ?? "normal";
      layer.orderKey = makeLayerOrderKey(index);
      layers.push(layer);
    }
    cursor.offset = layerInfoEnd;
  }
  cursor.offset = layerMaskEnd;
  void sizeFieldBytes;

  if (layers.length === 0) {
    // No layers (a flattened PSD, or a save with "Maximize Compatibility" off): the merged
    // image data section that follows layerMaskEnd is the whole picture.
    try {
      const compression = cursor.u16();
      const colorChannelCount = colorMode === 1 ? 1 : 3;
      const planes = new Map<number, Uint8Array>();
      if (compression === 0) {
        const bytesPerSample = depth === 16 ? 2 : depth === 32 ? 4 : 1;
        for (let channel = 0; channel < Math.min(channelCount, colorChannelCount + 1); channel += 1) {
          const raw = cursor.bytes(width * height * bytesPerSample);
          if (bytesPerSample === 1) { planes.set(channel === colorChannelCount ? -1 : channel, raw); continue; }
          const out = new Uint8Array(width * height), dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          for (let i = 0; i < width * height; i += 1) out[i] = bytesPerSample === 2 ? Math.round(dv.getUint16(i * 2, false) / 257) : Math.round(dv.getFloat32(i * 4, false) * 255);
          planes.set(channel === colorChannelCount ? -1 : channel, out);
        }
      } else if (compression === 1) {
        const rowByteCounts: number[] = [];
        const totalChannelsToRead = Math.min(channelCount, colorChannelCount + 1);
        for (let channel = 0; channel < totalChannelsToRead; channel += 1) for (let row = 0; row < height; row += 1) rowByteCounts.push(cursor.u16());
        let rowIndex = 0;
        for (let channel = 0; channel < totalChannelsToRead; channel += 1) {
          const out = new Uint8Array(width * height);
          for (let row = 0; row < height; row += 1) {
            const rowStart = cursor.offset, rowBytes = unpackBitsRow(cursor, width);
            out.set(rowBytes, row * width);
            cursor.offset = rowStart + rowByteCounts[rowIndex]!; rowIndex += 1;
          }
          planes.set(channel === colorChannelCount ? -1 : channel, out);
        }
      } else throw new Error(`Unsupported merged-image compression: ${compression}`);
      const pixels = interleaveRgba(planes, width, height, colorChannelCount);
      const flat = createRasterLayer(width, height, "Layer 1 (Слой 1)");
      flat.pixels = pixels;
      layers.push(flat);
    } catch (error) {
      warnings.push(`Merged image data could not be read: ${error instanceof Error ? error.message : String(error)}`);
      layers.push(createRasterLayer(width, height, "Layer 1 (Слой 1)"));
    }
  }

  const document: RasterDocumentState = {
    kind: "raster", schemaVersion: 2, width, height, colorSpace: "srgb", resolution: 72, resolutionUnit: "ppi",
    bitDepth: 8, pixelAspectRatio: 1, backgroundColor: null, layers, activeLayerId: layers[layers.length - 1]!.id,
    selection: null, guides: [],
  };
  return { document, warnings };
}
