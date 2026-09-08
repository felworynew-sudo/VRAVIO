import { describe, expect, it } from "vitest";
import { computeSpectrogram, heatMapColor } from "./spectrogram";

function sineWave(length: number, frequencyHz: number, sampleRate: number, amplitude = 1): Float32Array {
  const wave = new Float32Array(length);
  for (let i = 0; i < length; i += 1) wave[i] = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude;
  return wave;
}

function dominantBinIndex(frame: Float32Array): number {
  let bestIndex = 0, bestValue = -Infinity;
  for (let i = 0; i < frame.length; i += 1) if (frame[i]! > bestValue) { bestValue = frame[i]!; bestIndex = i; }
  return bestIndex;
}

describe("computeSpectrogram", () => {
  it("rejects a non-power-of-two fftSize", () => {
    expect(() => computeSpectrogram(new Float32Array(4096), 48000, { fftSize: 1000 })).toThrow(RangeError);
  });

  it("produces the expected number of frames for a given hop size", () => {
    const sampleRate = 48000;
    const channel = sineWave(8192, 440, sampleRate);
    const result = computeSpectrogram(channel, sampleRate, { fftSize: 1024, hopSize: 512 });
    // frames while start + fftSize <= length: start = 0, 512, 1024, ... up to 8192-1024=7168
    const expectedFrames = Math.floor((channel.length - 1024) / 512) + 1;
    expect(result.frames.length).toBe(expectedFrames);
    expect(result.frames[0]).toHaveLength(512); // fftSize / 2
  });

  it("finds the dominant frequency bin close to a pure tone's actual frequency", () => {
    const sampleRate = 48000, fftSize = 2048;
    const frequencyHz = 1000;
    const channel = sineWave(fftSize * 4, frequencyHz, sampleRate, 0.8);
    const result = computeSpectrogram(channel, sampleRate, { fftSize });

    const binHz = sampleRate / fftSize;
    const expectedBin = Math.round(frequencyHz / binHz);
    // Check a middle frame (avoids window edge effects at the very first/last frame).
    const middleFrame = result.frames[Math.floor(result.frames.length / 2)]!;
    const foundBin = dominantBinIndex(middleFrame);
    expect(Math.abs(foundBin - expectedBin)).toBeLessThanOrEqual(1);
  });

  it("reports louder energy for a louder tone at the same frequency", () => {
    const sampleRate = 48000, fftSize = 1024;
    const quiet = computeSpectrogram(sineWave(fftSize * 4, 2000, sampleRate, 0.1), sampleRate, { fftSize });
    const loud = computeSpectrogram(sineWave(fftSize * 4, 2000, sampleRate, 0.9), sampleRate, { fftSize });
    const quietFrame = quiet.frames[Math.floor(quiet.frames.length / 2)]!;
    const loudFrame = loud.frames[Math.floor(loud.frames.length / 2)]!;
    const quietPeak = Math.max(...quietFrame);
    const loudPeak = Math.max(...loudFrame);
    expect(loudPeak).toBeGreaterThan(quietPeak);
  });

  it("floors magnitude at -100 dB rather than going to -Infinity for silence", () => {
    const result = computeSpectrogram(new Float32Array(4096), 48000, { fftSize: 1024 });
    for (const frame of result.frames) for (const value of frame) expect(value).toBeGreaterThanOrEqual(-100);
  });

  it("returns no frames when the channel is shorter than one fftSize window", () => {
    const result = computeSpectrogram(new Float32Array(100), 48000, { fftSize: 1024 });
    expect(result.frames).toHaveLength(0);
  });
});

describe("heatMapColor", () => {
  it("is black at 0 and clamps below 0", () => {
    expect(heatMapColor(0)).toEqual([0, 0, 0]);
    expect(heatMapColor(-5)).toEqual([0, 0, 0]);
  });

  it("is bright yellow at 1 and clamps above 1", () => {
    expect(heatMapColor(1)).toEqual([255, 255, 80]);
    expect(heatMapColor(5)).toEqual([255, 255, 80]);
  });

  it("returns increasing overall brightness as the input increases", () => {
    const brightness = (color: readonly [number, number, number]) => color[0] + color[1] + color[2];
    expect(brightness(heatMapColor(0.25))).toBeGreaterThan(brightness(heatMapColor(0)));
    expect(brightness(heatMapColor(0.75))).toBeGreaterThan(brightness(heatMapColor(0.25)));
  });
});
