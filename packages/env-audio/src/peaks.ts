/**
 * Waveform peak generation — ported from waveform-playlist's
 * `packages/core/src/utils/peaksGenerator.ts` (MIT): min/max sample pairs per pixel-column,
 * the standard format every waveform-drawing library (including this donor's own) expects.
 */

export interface PeakData {
  readonly bits: 8 | 16;
  readonly samplesPerPixel: number;
  /** min/max pairs, one pair per column: `[min0, max0, min1, max1, …]`. */
  readonly values: Int8Array | Int16Array;
}

export function generatePeaks(samples: Float32Array, samplesPerPixel: number, bits: 8 | 16 = 16): Int8Array | Int16Array {
  if (samplesPerPixel <= 0) throw new RangeError("samplesPerPixel must be positive");
  const numPeaks = Math.ceil(samples.length / samplesPerPixel);
  const peaks = bits === 8 ? new Int8Array(numPeaks * 2) : new Int16Array(numPeaks * 2);
  const maxValue = 2 ** (bits - 1);

  for (let i = 0; i < numPeaks; i += 1) {
    const start = i * samplesPerPixel, end = Math.min(start + samplesPerPixel, samples.length);
    let min = 0, max = 0;
    for (let j = start; j < end; j += 1) {
      const value = samples[j]!;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    peaks[i * 2] = Math.max(-maxValue, Math.floor(min * maxValue));
    peaks[i * 2 + 1] = Math.min(maxValue - 1, Math.floor(max * maxValue));
  }
  return peaks;
}

/** Peaks for a multi-channel buffer, mixed down to mono first (simple average) — what a
 * track's own compact waveform display draws; per-channel peaks are `generatePeaks` called on
 * one `channelData[c]` directly, for a stereo-split view. */
export function generateMonoPeaks(channelData: readonly Float32Array[], samplesPerPixel: number, bits: 8 | 16 = 16): Int8Array | Int16Array {
  if (channelData.length === 1) return generatePeaks(channelData[0]!, samplesPerPixel, bits);
  const length = Math.max(...channelData.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (const channel of channelData) for (let i = 0; i < channel.length; i += 1) mono[i]! += channel[i]! / channelData.length;
  return generatePeaks(mono, samplesPerPixel, bits);
}

/** Reads one peak pair back out as normalized floats in [-1, 1], for rendering. */
export function readPeak(peaks: Int8Array | Int16Array, index: number, bits: 8 | 16 = 16): { min: number; max: number } {
  const maxValue = 2 ** (bits - 1);
  return { min: (peaks[index * 2] ?? 0) / maxValue, max: (peaks[index * 2 + 1] ?? 0) / maxValue };
}
