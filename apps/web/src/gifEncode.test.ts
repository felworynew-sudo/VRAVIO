import { describe, expect, it } from "vitest";
import { encodeGifPixels, quantizeForGif } from "./gifEncode";

/** Minimal standalone GIF89a + LZW decoder, written only to verify the encoder round-trips —
 * deliberately independent of `gifEncode.ts`'s own code so a shared bug in both wouldn't hide. */
function decodeGif(bytes: Uint8Array): { width: number; height: number; rgba: Uint8ClampedArray } {
  let pos = 6;
  const width = bytes[pos]! | (bytes[pos + 1]! << 8); pos += 2;
  const height = bytes[pos]! | (bytes[pos + 1]! << 8); pos += 2;
  const packed = bytes[pos]!; pos += 1;
  pos += 2; // background color index + pixel aspect ratio
  const globalTableFlag = (packed & 0x80) !== 0;
  const globalSizeBits = (packed & 0x07) + 1;
  let globalTable: [number, number, number][] = [];
  if (globalTableFlag) {
    const entries = 1 << globalSizeBits;
    for (let i = 0; i < entries; i += 1) { globalTable.push([bytes[pos]!, bytes[pos + 1]!, bytes[pos + 2]!]); pos += 3; }
  }
  let transparentIndex = -1;
  while (bytes[pos] === 0x21) {
    const label = bytes[pos + 1]!;
    pos += 2;
    if (label === 0xf9) {
      const size = bytes[pos]!; pos += 1;
      const flags = bytes[pos]!;
      if (flags & 0x01) transparentIndex = bytes[pos + 3]!;
      pos += size;
      pos += 1; // block terminator
    } else {
      pos += 1;
      while (bytes[pos] !== 0) { pos += 1 + bytes[pos]!; }
      pos += 1;
    }
  }
  if (bytes[pos] !== 0x2c) throw new Error("expected image descriptor");
  pos += 1;
  pos += 8; // left, top, width, height (redundant with logical screen for our encoder)
  const imagePacked = bytes[pos]!; pos += 1;
  const localTableFlag = (imagePacked & 0x80) !== 0;
  let table = globalTable;
  if (localTableFlag) {
    const localSizeBits = (imagePacked & 0x07) + 1;
    table = [];
    const entries = 1 << localSizeBits;
    for (let i = 0; i < entries; i += 1) { table.push([bytes[pos]!, bytes[pos + 1]!, bytes[pos + 2]!]); pos += 3; }
  }
  const minCodeSize = bytes[pos]!; pos += 1;

  const dataBytes: number[] = [];
  while (bytes[pos] !== 0) { const size = bytes[pos]!; pos += 1; for (let i = 0; i < size; i += 1) dataBytes.push(bytes[pos + i]!); pos += size; }

  const clearCode = 1 << minCodeSize, endCode = clearCode + 1;
  let dictionary: number[][] = [];
  const resetDictionary = () => { dictionary = []; for (let i = 0; i < clearCode; i += 1) dictionary.push([i]); dictionary.push([], []); };
  resetDictionary();
  let codeWidth = minCodeSize + 1;
  let bitBuffer = 0, bitCount = 0, byteIndex = 0;
  const readCode = (): number => {
    while (bitCount < codeWidth) { bitBuffer |= dataBytes[byteIndex]! << bitCount; byteIndex += 1; bitCount += 8; }
    const code = bitBuffer & ((1 << codeWidth) - 1);
    bitBuffer >>>= codeWidth; bitCount -= codeWidth;
    return code;
  };

  const indexes: number[] = [];
  let previous: number[] | null = null;
  for (;;) {
    const code = readCode();
    if (code === clearCode) { resetDictionary(); codeWidth = minCodeSize + 1; previous = null; continue; }
    if (code === endCode) break;
    let entry: number[];
    if (code < dictionary.length && dictionary[code]!.length > 0) entry = dictionary[code]!;
    else if (code === dictionary.length && previous) entry = [...previous, previous[0]!];
    else throw new Error(`invalid LZW code ${code}`);
    indexes.push(...entry);
    if (previous) {
      dictionary.push([...previous, entry[0]!]);
      if (dictionary.length === (1 << codeWidth) && codeWidth < 12) codeWidth += 1;
    }
    previous = entry;
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const index = indexes[i]!;
    const color = table[index] ?? [0, 0, 0];
    rgba[i * 4] = color[0]; rgba[i * 4 + 1] = color[1]; rgba[i * 4 + 2] = color[2];
    rgba[i * 4 + 3] = index === transparentIndex ? 0 : 255;
  }
  return { width, height, rgba };
}

describe("GIF encoder", () => {
  it("round-trips an exact ≤256-color image losslessly", async () => {
    const width = 8, height = 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 32) % 256; rgba[i + 1] = (y * 32) % 256; rgba[i + 2] = 128; rgba[i + 3] = 255;
    }
    const { palette, indexes, transparentIndex } = quantizeForGif(rgba, width, height, 256, false);
    const blob = encodeGifPixels(width, height, palette, indexes, transparentIndex);
    const decoded = decodeGif(new Uint8Array(await blob.arrayBuffer()));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect([...decoded.rgba]).toEqual([...rgba]);
  });

  it("collapses fully transparent pixels to a single reserved index and preserves opaque colors", async () => {
    const width = 4, height = 1;
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255]);
    const { palette, indexes, transparentIndex } = quantizeForGif(rgba, width, height, 256, false);
    expect(transparentIndex).toBeGreaterThanOrEqual(0);
    const blob = encodeGifPixels(width, height, palette, indexes, transparentIndex);
    const decoded = decodeGif(new Uint8Array(await blob.arrayBuffer()));
    expect([...decoded.rgba.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...decoded.rgba.slice(4, 8)]).toEqual([0, 255, 0, 255]);
    expect(decoded.rgba[11]).toBe(0); // alpha of the transparent pixel
    expect([...decoded.rgba.slice(12, 16)]).toEqual([0, 0, 255, 255]);
  });

  it("reduces a many-color gradient to at most the requested palette size", () => {
    const width = 64, height = 1;
    const rgba = new Uint8ClampedArray(width * 4);
    for (let x = 0; x < width; x += 1) { rgba[x * 4] = x * 4; rgba[x * 4 + 1] = 0; rgba[x * 4 + 2] = 0; rgba[x * 4 + 3] = 255; }
    const { palette } = quantizeForGif(rgba, width, height, 16, false);
    expect(palette.length).toBeLessThanOrEqual(16);
  });

  it("rejects zero-sized dimensions", () => {
    expect(() => encodeGifPixels(0, 1, [[0, 0, 0]], new Uint8Array(0), -1)).toThrow(RangeError);
  });
});
