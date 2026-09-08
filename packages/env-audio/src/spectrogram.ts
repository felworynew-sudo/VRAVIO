/**
 * Short-time Fourier transform spectrogram — docs/master-plan.md §9.2's Audacity-4 phase.
 * A radix-2 Cooley-Tukey FFT written here rather than pulling in a dependency (waveform-
 * playlist's own `dawcore-spectrogram` package uses the `fft.js` library) — `packages/env-audio`
 * has had zero runtime dependencies besides `@vravio/kernel` since it was created (its own WAV
 * codec is the same choice, made for the same reason: one well-understood, small, and fully
 * tested algorithm is worth more here than a dependency for something this contained).
 */
import { hannWindow } from "./effects";

/** In-place iterative radix-2 Cooley-Tukey FFT. `real`/`imag` must have a power-of-two length. */
function fftInPlace(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tempReal = real[i]!; real[i] = real[j]!; real[j] = tempReal;
      const tempImag = imag[i]!; imag[i] = imag[j]!; imag[j] = tempImag;
    }
  }
  // Iterative Danielson-Lanczos.
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const angle = angleStep * k;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const evenIndex = start + k, oddIndex = start + k + half;
        const oddReal = real[oddIndex]! * cos - imag[oddIndex]! * sin;
        const oddImag = real[oddIndex]! * sin + imag[oddIndex]! * cos;
        real[oddIndex] = real[evenIndex]! - oddReal;
        imag[oddIndex] = imag[evenIndex]! - oddImag;
        real[evenIndex] = real[evenIndex]! + oddReal;
        imag[evenIndex] = imag[evenIndex]! + oddImag;
      }
    }
  }
}

function isPowerOfTwo(value: number): boolean { return value > 0 && (value & (value - 1)) === 0; }

export interface SpectrogramOptions {
  /** Samples per FFT frame — must be a power of two. Larger = better frequency resolution,
   * worse time resolution. */
  readonly fftSize?: number;
  /** Samples between consecutive frames — smaller overlaps more, giving a smoother image at
   * proportionally more compute. Defaults to a quarter of `fftSize` (75% overlap). */
  readonly hopSize?: number;
}

export interface SpectrogramResult {
  /** One frame per analysis window, each `fftSize / 2` bins of magnitude in dB (≤ 0, floored at
   * -100 dB), lowest frequency first. */
  readonly frames: readonly Float32Array[];
  readonly fftSize: number;
  readonly hopSize: number;
  readonly sampleRate: number;
}

const DB_FLOOR = -100;

/**
 * Computes a magnitude spectrogram via short-time FFT: a Hann-windowed frame every `hopSize`
 * samples, each transformed and reduced to `fftSize / 2` dB-scale magnitude bins. Pure and
 * synchronous — for a very long clip a caller may want to chunk this across frames (or a
 * worker) rather than blocking the main thread for seconds; not needed at the clip lengths
 * this editor deals with today, so not built ahead of an actual need.
 */
export function computeSpectrogram(channel: Float32Array, sampleRate: number, options: SpectrogramOptions = {}): SpectrogramResult {
  const fftSize = options.fftSize ?? 1024;
  if (!isPowerOfTwo(fftSize)) throw new RangeError(`fftSize must be a power of two, got ${fftSize}`);
  const hopSize = Math.max(1, Math.floor(options.hopSize ?? fftSize / 4));
  const window = hannWindow(fftSize);
  const half = fftSize / 2;

  const frames: Float32Array[] = [];
  for (let start = 0; start + fftSize <= channel.length; start += hopSize) {
    const real = new Float32Array(fftSize), imag = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i += 1) real[i] = channel[start + i]! * window[i]!;
    fftInPlace(real, imag);

    const frame = new Float32Array(half);
    for (let i = 0; i < half; i += 1) {
      const magnitude = Math.sqrt(real[i]! * real[i]! + imag[i]! * imag[i]!) / fftSize;
      const db = 20 * Math.log10(magnitude + 1e-10);
      frame[i] = Math.max(DB_FLOOR, db);
    }
    frames.push(frame);
  }
  return { frames, fftSize, hopSize, sampleRate };
}

/**
 * Maps a normalized magnitude (0 = silent, 1 = loudest) to an RGB heat-map color — black
 * through blue/purple/orange to bright yellow, the same rough shape every spectrogram viewer
 * (Audacity included) uses because it reads intensity intuitively without needing a legend.
 */
export function heatMapColor(normalized: number): readonly [number, number, number] {
  const t = Math.max(0, Math.min(1, normalized));
  // Piecewise-linear through a handful of anchor colors.
  const stops: readonly (readonly [number, number, number, number])[] = [
    [0, 0, 0, 0], [0.25, 40, 0, 90], [0.5, 120, 20, 120], [0.75, 230, 90, 40], [1, 255, 255, 80],
  ];
  for (let i = 1; i < stops.length; i += 1) {
    const [stopPosition, r, g, b] = stops[i]!;
    if (t <= stopPosition) {
      const [previousPosition, previousR, previousG, previousB] = stops[i - 1]!;
      const span = stopPosition - previousPosition;
      const localT = span > 0 ? (t - previousPosition) / span : 0;
      return [
        Math.round(previousR + (r - previousR) * localT),
        Math.round(previousG + (g - previousG) * localT),
        Math.round(previousB + (b - previousB) * localT),
      ];
    }
  }
  return [255, 255, 80];
}
