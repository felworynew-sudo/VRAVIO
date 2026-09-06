import { describe, expect, it } from "vitest";
import { buildTestCmykIccProfile, buildTestCmykIccProfileA2bOnly, cmykToSrgb, srgbToCmyk, validateIccProfile } from "./vector-color-wasm";

/**
 * Stage 14 of docs/vector-plan.md: real, ICC-based colour management, via
 * `crates/vector-color` (`qcms` for CMYK→sRGB, `moxcms` for sRGB→CMYK,
 * added 6 September 2026 once that direction had an actual pure-Rust
 * donor — see the crate's README) — against the real compiled `.wasm`,
 * not a mock. Real conversion through an actual ICC profile, not the
 * naive `(1-c)(1-k)` formula `@vravio/kernel`'s `colorToCss` still uses
 * when no profile is available.
 *
 * There is no small, unambiguously-licensed real-world CMYK ICC profile
 * this repo can commit and embed, so both directions build their own
 * fixture at test time — but **not the same way**, and this is
 * deliberate, not an oversight:
 *
 * - `cmyk_to_srgb` (qcms) below uses `buildQcmsTestProfile`, a minimal
 *   ICC v2 profile **hand-written in this file**, byte for byte — proven
 *   to work (this is the original Stage 14 fixture, unchanged).
 * - `srgb_to_cmyk` (moxcms) uses `buildTestCmykIccProfile*`, which calls
 *   into `moxcms`'s own `ColorProfile::encode()` in the wasm module
 *   instead (see `vector-color-wasm.ts`'s doc comment on those two
 *   functions) — a second hand-written ICC byte layout was tried first
 *   and `moxcms` rejected it outright for reasons that stayed opaque even
 *   after checking every header field its own source validates.
 *
 * **The two fixtures are not interchangeable, on purpose.** A profile
 * built the `moxcms` way and then read by `qcms` was found (in
 * `crates/vector-color`'s own native test-writing process — see that
 * crate's `lib.rs`) to disagree on CLUT corner ordering:
 * `cmyk_to_srgb(0,0,0,0)` and `cmyk_to_srgb(0,0,0,255)` on such a profile
 * came back byte-identical, meaning qcms wasn't seeing the k-axis move at
 * all — confirmed a second time here, independently, when this file
 * first tried reusing the `moxcms`-built fixture for the qcms tests too:
 * the "different inputs, different outputs" and "real interpolation"
 * assertions below failed the exact same way. That is a genuine cross-
 * library incompatibility between two independently-implemented CMMs'
 * internal LUT-ordering conventions, not a bug in either library's own
 * read/write round trip — each direction here is only ever tested
 * against a profile built the way *that* direction's own library
 * expects.
 */

const LUT8_TYPE = 0x6d667431; // 'mft1'
const OUTPUT_DEVICE_PROFILE = 0x70727472; // 'prtr'
const CMYK_SIGNATURE = 0x434d594b; // 'CMYK'
const XYZ_SIGNATURE = 0x58595a20; // 'XYZ '
const TAG_A2B0 = 0x41324230; // 'A2B0'

/** Builds a minimal, syntactically valid ICC v2 CMYK profile: one `A2B0`
 * tag (`lut8Type`, 2 grid points per axis — the 16 corners of the CMYK
 * hypercube are the only points actually stored; every other input is
 * qcms's own tetrahedral interpolation between them). `corner(c, m, y, k)`
 * gives the XYZ triple (each 0..1) at one of those 16 corners —
 * deliberately not a per-channel-multiplicative (naive-formula-shaped)
 * function, so a test asserting "this used real multi-dimensional
 * interpolation" isn't accidentally satisfied by a profile that behaves
 * like the naive formula being replaced. */
function buildQcmsTestProfile(corner: (c: number, m: number, y: number, k: number) => readonly [number, number, number]): Uint8Array {
  const inChan = 4, outChan = 3, gridPoints = 2;
  const clutSize = gridPoints ** inChan; // 16
  const inputTableEntries = 256, outputTableEntries = 256;
  const matrixBytes = 9 * 4;
  const inputTableBytes = inputTableEntries * inChan;
  const clutBytes = clutSize * outChan;
  const outputTableBytes = outputTableEntries * outChan;
  const tagHeaderBytes = 12;
  const a2b0Size = tagHeaderBytes + matrixBytes + inputTableBytes + clutBytes + outputTableBytes;
  const tagTableStart = 128, a2b0Start = tagTableStart + 4 + 12;
  const totalSize = a2b0Start + a2b0Size;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint32(0, totalSize); // profile size
  view.setUint8(10, 0); view.setUint8(11, 0); // reserved bytes check_profile_version requires zero
  view.setUint32(12, OUTPUT_DEVICE_PROFILE); // class signature
  view.setUint32(16, CMYK_SIGNATURE); // colour space
  view.setUint32(20, XYZ_SIGNATURE); // PCS
  view.setUint32(64, 0); // rendering intent: Perceptual

  view.setUint32(tagTableStart, 1); // one tag
  view.setUint32(tagTableStart + 4, TAG_A2B0);
  view.setUint32(tagTableStart + 4 + 4, a2b0Start);
  view.setUint32(tagTableStart + 4 + 8, a2b0Size);

  let offset = a2b0Start;
  view.setUint32(offset, LUT8_TYPE); offset += 4;
  offset += 4; // reserved
  view.setUint8(offset, inChan); offset += 1;
  view.setUint8(offset, outChan); offset += 1;
  view.setUint8(offset, gridPoints); offset += 1;
  offset += 1; // reserved, pads to the matrix's own 4-byte alignment
  const matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const value of matrix) { view.setInt32(offset, Math.round(value * 65536)); offset += 4; }
  for (let channel = 0; channel < inChan; channel += 1) for (let i = 0; i < 256; i += 1) { bytes[offset] = i; offset += 1; }
  for (let index = 0; index < clutSize; index += 1) {
    const c = (index >> 3) & 1, m = (index >> 2) & 1, y = (index >> 1) & 1, k = index & 1;
    const [x, yy, z] = corner(c, m, y, k);
    bytes[offset] = Math.round(x * 255); offset += 1;
    bytes[offset] = Math.round(yy * 255); offset += 1;
    bytes[offset] = Math.round(z * 255); offset += 1;
  }
  for (let channel = 0; channel < outChan; channel += 1) for (let i = 0; i < 256; i += 1) { bytes[offset] = i; offset += 1; }

  return bytes;
}

const qcmsTestProfile = buildQcmsTestProfile((c, m, y, k) => [
  0.15 + 0.10 * c + 0.05 * m + 0.03 * y + 0.02 * k,
  0.15 + 0.02 * c + 0.10 * m + 0.05 * y + 0.03 * k,
  0.35 - 0.05 * c - 0.05 * m - 0.05 * y - 0.25 * k,
]);

describe("vector-color — real ICC CMYK→sRGB conversion via qcms", () => {
  it("accepts a well-formed ICC profile", async () => {
    expect(await validateIccProfile(qcmsTestProfile)).toBe(true);
  });

  it("rejects bytes that are not an ICC profile at all", async () => {
    expect(await validateIccProfile(new Uint8Array(200))).toBe(false);
    expect(await validateIccProfile(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("converts pure white ink (0,0,0,0) to a light colour and full black (0,0,0,1) to a dark one", async () => {
    const white = await cmykToSrgb(0, 0, 0, 0, qcmsTestProfile);
    const black = await cmykToSrgb(0, 0, 0, 1, qcmsTestProfile);
    expect(white).not.toBeNull();
    expect(black).not.toBeNull();
    const brightness = (rgb: readonly [number, number, number]) => rgb[0] + rgb[1] + rgb[2];
    expect(brightness(white!)).toBeGreaterThan(brightness(black!));
  });

  it("is non-vacuous: different CMYK inputs produce different sRGB outputs", async () => {
    const a = await cmykToSrgb(1, 0, 0, 0, qcmsTestProfile);
    const b = await cmykToSrgb(0, 1, 0, 0, qcmsTestProfile);
    const c = await cmykToSrgb(0, 0, 1, 0, qcmsTestProfile);
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(a).not.toEqual(c);
  });

  it("interpolates between stored corners rather than snapping to one — proof this is real multi-dimensional LUT math, not a lookup table of 16 fixed answers", async () => {
    const cZero = await cmykToSrgb(0, 0, 0, 0, qcmsTestProfile);
    const cOne = await cmykToSrgb(1, 0, 0, 0, qcmsTestProfile);
    const cHalf = await cmykToSrgb(0.5, 0, 0, 0, qcmsTestProfile);
    expect(cZero).not.toBeNull(); expect(cOne).not.toBeNull(); expect(cHalf).not.toBeNull();
    for (let channel = 0; channel < 3; channel += 1) {
      const zeroValue = cZero![channel]!, oneValue = cOne![channel]!, halfValue = cHalf![channel]!;
      const lo = Math.min(zeroValue, oneValue), hi = Math.max(zeroValue, oneValue);
      expect(halfValue).toBeGreaterThanOrEqual(Math.max(0, lo - 5));
      expect(halfValue).toBeLessThanOrEqual(Math.min(255, hi + 5));
    }
    expect(cHalf).not.toEqual(cZero);
    expect(cHalf).not.toEqual(cOne);
  });

  it("returns null for a profile qcms cannot use as the CMYK side of this transform", async () => {
    expect(await cmykToSrgb(0, 0, 0, 0, new Uint8Array(200))).toBeNull();
  });
});

/** 16 CMYK-hypercube corners × 3 XYZ output channels, each 0..255, for
 * `buildTestCmykIccProfile*`'s `a2bCorners` argument — same corner-
 * addressing convention as `buildQcmsTestProfile` above (bit order
 * c,m,y,k from MSB to LSB), used only because `srgb_to_cmyk`'s own tests
 * below also need *some* A2B tag present in the profile (`moxcms` parses
 * the whole profile even though this direction only exercises B2A). */
function flatA2bCorners(corner: (c: number, m: number, y: number, k: number) => readonly [number, number, number]): Uint8Array {
  const out = new Uint8Array(16 * 3);
  for (let index = 0; index < 16; index += 1) {
    const c = (index >> 3) & 1, m = (index >> 2) & 1, y = (index >> 1) & 1, k = index & 1;
    const [x, yy, z] = corner(c, m, y, k);
    out[index * 3] = Math.round(x * 255);
    out[index * 3 + 1] = Math.round(yy * 255);
    out[index * 3 + 2] = Math.round(z * 255);
  }
  return out;
}

/** 8 XYZ-hypercube corners × 4 CMYK output channels, each 0..255 —
 * mirror of `flatA2bCorners` for the B2A (moxcms) direction. */
function flatB2aCorners(corner: (x: number, y: number, z: number) => readonly [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(8 * 4);
  for (let index = 0; index < 8; index += 1) {
    const x = (index >> 2) & 1, y = (index >> 1) & 1, z = index & 1;
    const [c, m, yy, k] = corner(x, y, z);
    out[index * 4] = Math.round(c * 255);
    out[index * 4 + 1] = Math.round(m * 255);
    out[index * 4 + 2] = Math.round(yy * 255);
    out[index * 4 + 3] = Math.round(k * 255);
  }
  return out;
}

const a2bCorners = flatA2bCorners((c, m, y, k) => [
  0.15 + 0.10 * c + 0.05 * m + 0.03 * y + 0.02 * k,
  0.15 + 0.02 * c + 0.10 * m + 0.05 * y + 0.03 * k,
  0.35 - 0.05 * c - 0.05 * m - 0.05 * y - 0.25 * k,
]);

/** Distinct, non-symmetric per-channel weights — same "not naive-formula-
 * shaped" requirement as `flatA2bCorners`'s own doc comment. */
const b2aCorners = flatB2aCorners((x, y, z) => [
  0.05 + 0.30 * (1 - x) + 0.05 * (1 - y) + 0.03 * (1 - z),
  0.05 + 0.05 * (1 - x) + 0.30 * (1 - y) + 0.04 * (1 - z),
  0.05 + 0.04 * (1 - x) + 0.05 * (1 - y) + 0.30 * (1 - z),
  0.02 + 0.15 * (1 - x) * (1 - y) * (1 - z),
]);

describe("vector-color — real ICC sRGB→CMYK conversion via moxcms (B2A)", () => {
  it("accepts a well-formed ICC profile with both A2B and B2A tags", async () => {
    const profile = await buildTestCmykIccProfile(a2bCorners, b2aCorners);
    expect(await validateIccProfile(profile)).toBe(true);
  });

  it("is non-vacuous: different sRGB inputs produce different CMYK outputs", async () => {
    const profile = await buildTestCmykIccProfile(a2bCorners, b2aCorners);
    const a = await srgbToCmyk(255, 0, 0, profile);
    const b = await srgbToCmyk(0, 255, 0, profile);
    const c = await srgbToCmyk(0, 0, 255, profile);
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(a).not.toEqual(c);
  });

  it("interpolates between stored corners rather than snapping to one — proof this is real multi-dimensional LUT math, not 8 fixed answers", async () => {
    const profile = await buildTestCmykIccProfile(a2bCorners, b2aCorners);
    const xZero = await srgbToCmyk(0, 255, 255, profile);
    const xOne = await srgbToCmyk(255, 255, 255, profile);
    const xHalf = await srgbToCmyk(128, 255, 255, profile);
    expect(xZero).not.toBeNull(); expect(xOne).not.toBeNull(); expect(xHalf).not.toBeNull();
    for (let channel = 0; channel < 4; channel += 1) {
      const zeroValue = xZero![channel]!, oneValue = xOne![channel]!, halfValue = xHalf![channel]!;
      const lo = Math.min(zeroValue, oneValue), hi = Math.max(zeroValue, oneValue);
      const margin = 5 / 255;
      expect(halfValue).toBeGreaterThanOrEqual(Math.max(0, lo - margin));
      expect(halfValue).toBeLessThanOrEqual(Math.min(1, hi + margin));
    }
    expect(xHalf).not.toEqual(xZero);
    expect(xHalf).not.toEqual(xOne);
  });

  it("returns null for a profile with no B2A tag (A2B0-only, the direction cmyk_to_srgb already covers)", async () => {
    const a2bOnly = await buildTestCmykIccProfileA2bOnly(a2bCorners);
    expect(await srgbToCmyk(255, 0, 0, a2bOnly)).toBeNull();
  });

  it("returns null for bytes that are not an ICC profile at all", async () => {
    expect(await srgbToCmyk(255, 0, 0, new Uint8Array(200))).toBeNull();
  });
});
