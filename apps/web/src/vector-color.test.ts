import { describe, expect, it } from "vitest";
import { cmykToSrgb, validateIccProfile } from "./vector-color-wasm";

/**
 * Stage 14 of docs/vector-plan.md: real, ICC-based colour management, via
 * `crates/vector-color` (qcms) — against the real compiled `.wasm`, not a
 * mock. See that crate's own README for this pass's honest scope: real
 * CMYK→sRGB conversion through an actual ICC profile, not the naive
 * `(1-c)(1-k)` formula `@vravio/kernel`'s `colorToCss` still uses when no
 * profile is available — and no `srgbToCmyk` (qcms itself has no such
 * transform; see the README for why).
 *
 * There is no small, unambiguously-licensed real-world CMYK ICC profile
 * this repo can commit and embed, so the fixture here is a minimal,
 * hand-built ICC v2 CMYK profile (an `A2B0` tag of the simplest LUT type
 * the format has, `lut8Type`, 2 grid points per channel) — enough for
 * qcms to accept as a real profile and route through its actual N-
 * dimensional CLUT interpolation and PCS math, which is the thing these
 * tests need to prove is actually happening (not a real-world printer's
 * characterization, which is not the point of a unit test).
 */

const LUT8_TYPE = 0x6d667431; // 'mft1'
const OUTPUT_DEVICE_PROFILE = 0x70727472; // 'prtr'
const CMYK_SIGNATURE = 0x434d594b; // 'CMYK'
const XYZ_SIGNATURE = 0x58595a20; // 'XYZ '
const TAG_A2B0 = 0x41324230; // 'A2B0'

/**
 * Builds a minimal, syntactically valid ICC v2 profile: CMYK input space,
 * XYZ PCS, one `A2B0` tag (`lut8Type`, grid_points=2 — the 16 corners of
 * the 4D CMYK cube are the only points actually stored; every other input
 * is qcms's own tetrahedral interpolation between them). `corner(c, m, y, k)`
 * gives the XYZ triple (each 0..1) at one of those 16 corners — deliberately
 * NOT a per-channel-multiplicative (naive-formula-shaped) function, so a
 * test asserting "this used real multi-dimensional interpolation" isn't
 * accidentally satisfied by a profile that behaves like the naive formula
 * being replaced.
 */
function buildTestCmykIccProfile(corner: (c: number, m: number, y: number, k: number) => readonly [number, number, number]): Uint8Array {
  const inChan = 4, outChan = 3, gridPoints = 2;
  const clutSize = gridPoints ** inChan; // 16
  const inputTableEntries = 256, outputTableEntries = 256;
  const matrixBytes = 9 * 4;
  const inputTableBytes = inputTableEntries * inChan; // identity ramp per channel, 1 byte each (lut8Type)
  const clutBytes = clutSize * outChan;
  const outputTableBytes = outputTableEntries * outChan;
  const tagHeaderBytes = 12; // type(4) + reserved(4) + inChan/outChan/gridPoints/reserved (4)
  const a2b0Size = tagHeaderBytes + matrixBytes + inputTableBytes + clutBytes + outputTableBytes;
  const tagTableStart = 128, a2b0Start = tagTableStart + 4 + 12; // one tag entry
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
  // Identity 3x3 matrix (unused for a 4-channel/CMYK input, but the
  // format always reserves the space) — e00=e11=e22=1.0 as s15Fixed16.
  const matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const value of matrix) { view.setInt32(offset, Math.round(value * 65536)); offset += 4; }
  // Input table: identity ramp, one 256-entry table per channel.
  for (let channel = 0; channel < inChan; channel += 1) for (let i = 0; i < 256; i += 1) { bytes[offset] = i; offset += 1; }
  // CLUT: the 16 corners of the CMYK hypercube, each an XYZ triple.
  for (let index = 0; index < clutSize; index += 1) {
    const c = (index >> 3) & 1, m = (index >> 2) & 1, y = (index >> 1) & 1, k = index & 1;
    const [x, yy, z] = corner(c, m, y, k);
    bytes[offset] = Math.round(x * 255); offset += 1;
    bytes[offset] = Math.round(yy * 255); offset += 1;
    bytes[offset] = Math.round(z * 255); offset += 1;
  }
  // Output table: identity ramp, one 256-entry table per output channel.
  for (let channel = 0; channel < outChan; channel += 1) for (let i = 0; i < 256; i += 1) { bytes[offset] = i; offset += 1; }

  return bytes;
}

/** Distinct per-channel weights on every one of X/Y/Z — deliberately not a
 * multiplicative (naive-formula-shaped) function, and with different
 * coefficients per channel so that (say) pure cyan and pure yellow ink
 * produce genuinely different corners rather than colliding by symmetry
 * (an earlier version of this fixture used c XOR y for X, which made
 * (1,0,0,0) and (0,0,1,0) land on the identical corner — a fixture bug,
 * not a qcms one, worth remembering: XOR-style corner functions are not
 * automatically "not naive", they can just as easily be accidentally
 * symmetric). Values stay inside a conservative 0.05..0.45 band — this
 * fixture cares about proving real interpolation happens, not about
 * exercising qcms's PCS-XYZ encoding at its extremes.
 */
const testProfile = buildTestCmykIccProfile((c, m, y, k) => [
  0.15 + 0.10 * c + 0.05 * m + 0.03 * y + 0.02 * k,
  0.15 + 0.02 * c + 0.10 * m + 0.05 * y + 0.03 * k,
  0.35 - 0.05 * c - 0.05 * m - 0.05 * y - 0.25 * k,
]);

describe("vector-color — real ICC CMYK→sRGB conversion via qcms", () => {
  it("accepts a well-formed ICC profile", async () => {
    expect(await validateIccProfile(testProfile)).toBe(true);
  });

  it("rejects bytes that are not an ICC profile at all", async () => {
    expect(await validateIccProfile(new Uint8Array(200))).toBe(false);
    expect(await validateIccProfile(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("converts pure white ink (0,0,0,0) to a light colour and full black (0,0,0,1) to a dark one", async () => {
    const white = await cmykToSrgb(0, 0, 0, 0, testProfile);
    const black = await cmykToSrgb(0, 0, 0, 1, testProfile);
    expect(white).not.toBeNull();
    expect(black).not.toBeNull();
    const brightness = (rgb: readonly [number, number, number]) => rgb[0] + rgb[1] + rgb[2];
    expect(brightness(white!)).toBeGreaterThan(brightness(black!));
  });

  it("is non-vacuous: different CMYK inputs produce different sRGB outputs", async () => {
    const a = await cmykToSrgb(1, 0, 0, 0, testProfile);
    const b = await cmykToSrgb(0, 1, 0, 0, testProfile);
    const c = await cmykToSrgb(0, 0, 1, 0, testProfile);
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(a).not.toEqual(c);
  });

  it("interpolates between stored corners rather than snapping to one — proof this is real multi-dimensional LUT math, not a lookup table of 16 fixed answers", async () => {
    // c=0.5 sits exactly between the c=0 and c=1 corners on every other
    // channel held at 0 — a real CLUT interpolates a value strictly
    // between those two corners' outputs; a formula with no notion of
    // "between" would either snap to one corner or ignore c entirely.
    const cZero = await cmykToSrgb(0, 0, 0, 0, testProfile);
    const cOne = await cmykToSrgb(1, 0, 0, 0, testProfile);
    const cHalf = await cmykToSrgb(0.5, 0, 0, 0, testProfile);
    expect(cZero).not.toBeNull(); expect(cOne).not.toBeNull(); expect(cHalf).not.toBeNull();
    for (let channel = 0; channel < 3; channel += 1) {
      const zeroValue = cZero![channel]!, oneValue = cOne![channel]!, halfValue = cHalf![channel]!;
      const lo = Math.min(zeroValue, oneValue), hi = Math.max(zeroValue, oneValue);
      // Loose bounds (interpolation through XYZ and back into sRGB is not
      // itself linear in the CMYK inputs) — what matters is landing
      // strictly inside the range, not snapping to either endpoint.
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
