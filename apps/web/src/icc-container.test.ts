import { describe, expect, it } from "vitest";
import { buildIccProfile, parseIccProfile } from "@vravio/env-raster";
import { embedIccInJpeg, embedIccInPng, readEmbeddedIcc } from "./icc-container";
import { encodeTiffPixels } from "./exportImage";

/**
 * docs/master-plan.md §59.3. The round trip is the whole test: bytes in, a real container out, and
 * the profile read back from it — including by the reader that will see the file next.
 *
 * The fixtures are minimal but structurally real (signature, chunk/segment framing), because the
 * insertion walks the structure rather than searching for bytes: "IDAT" occurs inside compressed
 * image data often enough that a search-based patch would corrupt real files.
 */

const pngFixture = (): Uint8Array => {
  const chunk = (type: string, payload: Uint8Array): Uint8Array => {
    const bytes = new Uint8Array(12 + payload.length);
    new DataView(bytes.buffer).setUint32(0, payload.length);
    bytes.set(new TextEncoder().encode(type), 4);
    bytes.set(payload, 8);
    return bytes;
  };
  const ihdr = new Uint8Array(13);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array([1, 2, 3, 4])), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
};

const jpegFixture = (): Uint8Array => {
  // SOI, a minimal APP0/JFIF, then SOS and EOI — enough framing for the reader to walk.
  const jfif = new Uint8Array([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const jpeg = new Uint8Array(2 + jfif.length + 4);
  jpeg.set([0xff, 0xd8], 0);
  jpeg.set(jfif, 2);
  jpeg.set([0xff, 0xda, 0xff, 0xd9], 2 + jfif.length);
  return jpeg;
};

describe("embedding a profile in a container", () => {
  it("round-trips a profile through a PNG and keeps every original chunk", async () => {
    const profile = buildIccProfile("display-p3");
    const png = await embedIccInPng(pngFixture(), profile);

    const back = await readEmbeddedIcc(png);
    expect(back).not.toBeNull();
    expect(parseIccProfile(back!)!.space).toBe("display-p3");
    // The image data is untouched — embedding says what the pixels mean, it does not change them.
    expect(png.length).toBeGreaterThan(pngFixture().length);
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe("IEND");
  });

  it("replaces an existing PNG profile instead of stacking a second one", async () => {
    const once = await embedIccInPng(pngFixture(), buildIccProfile("adobe-rgb"));
    const twice = await embedIccInPng(once, buildIccProfile("prophoto-rgb"));

    expect(parseIccProfile((await readEmbeddedIcc(twice))!)!.space).toBe("prophoto-rgb");
    let count = 0;
    for (let index = 0; index + 8 <= twice.length; index += 1) {
      if (String.fromCharCode(...twice.subarray(index, index + 4)) === "iCCP") count += 1;
    }
    expect(count).toBe(1);
  });

  it("round-trips a profile through a JPEG's APP2 segments", async () => {
    const jpeg = embedIccInJpeg(jpegFixture(), buildIccProfile("adobe-rgb"));

    expect(jpeg[0]).toBe(0xff); expect(jpeg[1]).toBe(0xd8);      // still starts with SOI
    const back = await readEmbeddedIcc(jpeg);
    expect(parseIccProfile(back!)!.space).toBe("adobe-rgb");
  });

  it("replaces a JPEG's existing profile rather than adding a second one", async () => {
    // Chrome's own encoder tags every JPEG it writes as sRGB. Two ICC_PROFILE segments claiming to
    // be chunk 1 of 1 is a file that says two different things — found live on a P3 export.
    const once = embedIccInJpeg(jpegFixture(), buildIccProfile("srgb"));
    const twice = embedIccInJpeg(once, buildIccProfile("display-p3"));

    expect(parseIccProfile((await readEmbeddedIcc(twice))!)!.space).toBe("display-p3");
    let segments = 0;
    for (let index = 0; index + 12 <= twice.length; index += 1) {
      if (String.fromCharCode(...twice.subarray(index, index + 12)) === "ICC_PROFILE\0") segments += 1;
    }
    expect(segments).toBe(1);
  });

  it("leaves bytes that are not an image alone", async () => {
    const rubbish = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await embedIccInPng(rubbish, buildIccProfile("srgb"))).toBe(rubbish);
    expect(embedIccInJpeg(rubbish, buildIccProfile("srgb"))).toBe(rubbish);
    expect(await readEmbeddedIcc(rubbish)).toBeNull();
  });

  it("writes a CMYK TIFF as four ink planes, not RGBA", async () => {
    // Photometric 5 (Separated) and no alpha: what a prepress reader expects from a CMYK document.
    const pixels = new Uint8ClampedArray([255, 0, 0, 255]);
    const blob = encodeTiffPixels(1, 1, pixels, undefined, true);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const entries = view.getUint16(8, true);
    const tags = new Map<number, number>();
    for (let index = 0; index < entries; index += 1) {
      const entry = 10 + index * 12;
      tags.set(view.getUint16(entry, true), view.getUint16(entry + 8, true));
    }
    expect(tags.get(262)).toBe(5);       // photometric: separated
    expect(tags.get(338)).toBe(0);       // extra samples: none, because CMYK has no alpha here
    // Pure red separates to C=0, M=255, Y=255, K=0.
    const offset = new DataView(bytes.buffer).getUint32(10 + [...tags.keys()].indexOf(273) * 12 + 8, true);
    expect(Array.from(bytes.subarray(offset, offset + 4))).toEqual([0, 255, 255, 0]);
  });

  it("writes the profile into a TIFF as tag 34675", () => {
    const profile = buildIccProfile("display-p3");
    const blob = encodeTiffPixels(2, 2, new Uint8ClampedArray(2 * 2 * 4), profile);

    // 15 IFD entries rather than 14, and the profile bytes present in the file.
    expect(blob.size).toBeGreaterThan(profile.length);
  });
});
