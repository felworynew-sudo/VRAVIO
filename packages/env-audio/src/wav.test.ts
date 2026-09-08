import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav, isWav, type WavBitDepth } from "./wav";

function sineWave(length: number, frequency = 0.05): Float32Array {
  const wave = new Float32Array(length);
  for (let i = 0; i < length; i += 1) wave[i] = Math.sin(2 * Math.PI * frequency * i) * 0.8;
  return wave;
}

describe("encodeWav / decodeWav round-trip", () => {
  for (const bitDepth of [16, 24, 32] as WavBitDepth[]) {
    it(`round-trips mono audio at ${bitDepth}-bit`, () => {
      const original = sineWave(200);
      const bytes = encodeWav([original], 44100, bitDepth);
      expect(isWav(bytes)).toBe(true);
      const decoded = decodeWav(bytes);
      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.channelData).toHaveLength(1);
      expect(decoded.channelData[0]).toHaveLength(200);
      // Integer PCM has quantization error; float is exact.
      const tolerance = bitDepth === 32 ? 1e-6 : bitDepth === 24 ? 1e-4 : 1e-3;
      for (let i = 0; i < 200; i += 1) expect(decoded.channelData[0]![i]!).toBeCloseTo(original[i]!, Math.round(-Math.log10(tolerance)));
    });
  }

  it("round-trips stereo audio, keeping channels independent", () => {
    const left = sineWave(100, 0.05), right = sineWave(100, 0.25);
    const bytes = encodeWav([left, right], 48000, 16);
    const decoded = decodeWav(bytes);
    expect(decoded.channelData).toHaveLength(2);
    expect(decoded.channelData[0]![1]!).not.toBeCloseTo(decoded.channelData[1]![1]!, 1);
  });

  it("writes a correct header (RIFF size, fmt chunk, format tag)", () => {
    const bytes = encodeWav([sineWave(10)], 48000, 16);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8); // RIFF chunk size
    expect(view.getUint16(20, true)).toBe(1); // integer PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000);
  });

  it("tags 32-bit output as IEEE float (format tag 3)", () => {
    const bytes = encodeWav([sineWave(10)], 48000, 32);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(20, true)).toBe(3);
  });
});

describe("decodeWav robustness", () => {
  it("skips a chunk before data (e.g. a LIST chunk some encoders write)", () => {
    const base = encodeWav([sineWave(20)], 44100, 16);
    // Splice a fake even-sized "LIST" chunk between fmt and data.
    const extra = new Uint8Array(8 + 4);
    const extraView = new DataView(extra.buffer);
    extraView.setUint32(0, 0x4c495354, false); // "LIST"
    extraView.setUint32(4, 4, true);
    const withExtra = new Uint8Array(base.length + extra.length);
    withExtra.set(base.subarray(0, 36)); // RIFF..fmt chunk
    withExtra.set(extra, 36);
    withExtra.set(base.subarray(36), 36 + extra.length); // data chunk onward
    // Fix the RIFF size to account for the inserted bytes.
    new DataView(withExtra.buffer).setUint32(4, withExtra.length - 8, true);

    const decoded = decodeWav(withExtra);
    expect(decoded.channelData[0]).toHaveLength(20);
  });

  it("rejects non-RIFF bytes", () => {
    expect(() => decodeWav(new Uint8Array(100))).toThrow(RangeError);
    expect(isWav(new Uint8Array(100))).toBe(false);
  });

  it("rejects an unsupported bit depth", () => {
    const bytes = encodeWav([sineWave(10)], 44100, 16);
    // Corrupt the bits-per-sample field to something unsupported.
    new DataView(bytes.buffer).setUint16(34, 8, true);
    expect(() => decodeWav(bytes)).toThrow(RangeError);
  });
});
