import { describe, expect, it } from "vitest";
import { encodeBmpPixels, encodeTiffPixels, exportFileName, exportPixelSize } from "./exportImage";

describe("image export containers", () => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]);

  it("writes a valid 24-bit BMP header and padded scanline", async () => {
    const bytes = new Uint8Array(await encodeBmpPixels(2, 1, pixels).arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("BM");
    expect(view.getUint32(2, true)).toBe(62);
    expect(view.getInt32(18, true)).toBe(2);
    expect(view.getInt32(22, true)).toBe(1);
    expect(view.getUint16(28, true)).toBe(24);
    expect([...bytes.slice(54, 60)]).toEqual([0, 0, 255, 0, 255, 0]);
  });

  it("writes a little-endian RGBA TIFF with an IFD", async () => {
    const bytes = new Uint8Array(await encodeTiffPixels(2, 1, pixels).arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("II");
    expect(view.getUint16(2, true)).toBe(42);
    expect(view.getUint32(4, true)).toBe(8);
    expect(view.getUint16(8, true)).toBe(14);
    expect([...bytes.slice(-pixels.length)]).toEqual([...pixels]);
  });

  it("keeps export sizing and file names deterministic", () => {
    expect(exportPixelSize({ width: 100, height: 50 } as never, .5)).toEqual({ width: 50, height: 25 });
    expect(exportFileName("Picture.psd", "tiff")).toBe("Picture.tif");
  });
});
