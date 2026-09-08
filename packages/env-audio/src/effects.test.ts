import { describe, expect, it } from "vitest";
import {
  applyPortableAudioEffect, audioEffectCatalog, audioEffectDefaults, changeSpeed, normalizeChannels,
  repairRange, reverseChannels, shiftPitch,
} from "./effects";

function sineWave(length: number, cyclesOverLength: number, amplitude = 1): Float32Array {
  const wave = new Float32Array(length);
  for (let i = 0; i < length; i += 1) wave[i] = Math.sin((2 * Math.PI * cyclesOverLength * i) / length) * amplitude;
  return wave;
}

describe("audioEffectCatalog", () => {
  it("declares all nine master-plan §9.2 effects", () => {
    const ids = audioEffectCatalog.map((definition) => definition.id);
    expect(ids).toEqual(["normalize", "reverse", "speed", "pitch", "repair", "eq", "compressor", "reverb", "delay"]);
  });

  it("flags exactly the browser-only effects as non-portable", () => {
    const nonPortable = audioEffectCatalog.filter((definition) => !definition.portable).map((definition) => definition.id);
    expect(nonPortable).toEqual(["eq", "compressor", "reverb", "delay"]);
  });

  it("gives every parameter a value within its own min/max", () => {
    for (const definition of audioEffectCatalog) for (const parameter of definition.parameters) {
      expect(parameter.value).toBeGreaterThanOrEqual(parameter.min);
      expect(parameter.value).toBeLessThanOrEqual(parameter.max);
    }
  });
});

describe("audioEffectDefaults", () => {
  it("reads each parameter's declared default", () => {
    expect(audioEffectDefaults("speed")).toEqual({ rate: 1 });
    expect(audioEffectDefaults("reverse")).toEqual({});
  });
});

describe("reverseChannels", () => {
  it("reverses each channel independently, without aliasing the input", () => {
    const left = Float32Array.from([1, 2, 3, 4]), right = Float32Array.from([5, 6, 7, 8]);
    const [reversedLeft, reversedRight] = reverseChannels([left, right]);
    expect([...reversedLeft!]).toEqual([4, 3, 2, 1]);
    expect([...reversedRight!]).toEqual([8, 7, 6, 5]);
    expect([...left]).toEqual([1, 2, 3, 4]); // original untouched
  });
});

describe("normalizeChannels", () => {
  it("peak-normalizes a quiet signal up to the target level", () => {
    const channel = sineWave(1000, 10, 0.1); // peak ~0.1
    const [output] = normalizeChannels([channel], { mode: 0, linked: 1, targetDb: -1 }); // target ~0.891
    let peak = 0;
    for (const sample of output!) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeCloseTo(10 ** (-1 / 20), 2);
  });

  it("links channels to one gain derived from the loudest, preserving relative balance", () => {
    const loud = sineWave(1000, 10, 0.5), quiet = sineWave(1000, 10, 0.25);
    const [outLoud, outQuiet] = normalizeChannels([loud, quiet], { mode: 0, linked: 1, targetDb: 0 });
    let peakLoud = 0, peakQuiet = 0;
    for (const s of outLoud!) peakLoud = Math.max(peakLoud, Math.abs(s));
    for (const s of outQuiet!) peakQuiet = Math.max(peakQuiet, Math.abs(s));
    expect(peakLoud).toBeCloseTo(1, 2);
    expect(peakQuiet / peakLoud).toBeCloseTo(0.5, 2); // ratio preserved
  });

  it("un-links channels to give each its own independent gain", () => {
    const loud = sineWave(1000, 10, 0.5), quiet = sineWave(1000, 10, 0.25);
    const [outLoud, outQuiet] = normalizeChannels([loud, quiet], { mode: 0, linked: 0, targetDb: 0 });
    let peakLoud = 0, peakQuiet = 0;
    for (const s of outLoud!) peakLoud = Math.max(peakLoud, Math.abs(s));
    for (const s of outQuiet!) peakQuiet = Math.max(peakQuiet, Math.abs(s));
    expect(peakLoud).toBeCloseTo(1, 2);
    expect(peakQuiet).toBeCloseTo(1, 2); // each independently normalized to the same target
  });

  it("RMS mode never lets the result clip past 0 dBFS even for a peaky signal", () => {
    const channel = new Float32Array(1000);
    channel[500] = 1; // one huge transient, otherwise silent -> tiny RMS
    const [output] = normalizeChannels([channel], { mode: 1, linked: 1, targetDb: 0 });
    let peak = 0;
    for (const sample of output!) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeLessThanOrEqual(1.0001);
  });

  it("leaves a silent channel untouched (no division by zero)", () => {
    const [output] = normalizeChannels([new Float32Array(100)], { mode: 0, linked: 1, targetDb: -1 });
    expect(output!.every((sample) => sample === 0)).toBe(true);
  });
});

describe("repairRange", () => {
  it("replaces a range with a straight interpolation between its neighbors", () => {
    const channel = Float32Array.from([0, 0, 10, 10, 10, 0, 0]);
    const [output] = repairRange([channel], { startSample: 2, endSample: 5 });
    expect(output![1]).toBe(0); // untouched before
    expect(output![5]).toBe(0); // untouched after
    // Interpolated values move monotonically from ~0 toward ~0 (both neighbors are 0 here),
    // so use a case with different neighbors instead to check the ramp direction:
  });

  it("ramps between differing neighbor values", () => {
    const channel = Float32Array.from([0, 0, 10, 10, 10, 10, 1]);
    const [output] = repairRange([channel], { startSample: 2, endSample: 6 });
    // Neighbors: before=index1=0, after=index6=1 (unaffected). Interpolated 2..5 should
    // increase monotonically from near 0 toward near 1.
    expect(output![2]!).toBeLessThan(output![3]!);
    expect(output![3]!).toBeLessThan(output![4]!);
    expect(output![4]!).toBeLessThan(output![5]!);
  });

  it("no-ops for an empty or inverted range", () => {
    const channel = Float32Array.from([1, 2, 3]);
    const [output] = repairRange([channel], { startSample: 2, endSample: 2 });
    expect([...output!]).toEqual([1, 2, 3]);
  });
});

describe("changeSpeed", () => {
  it("shortens the buffer when speeding up, lengthens it when slowing down", () => {
    const channel = sineWave(1000, 5);
    const [faster] = changeSpeed([channel], { rate: 2 });
    const [slower] = changeSpeed([channel], { rate: 0.5 });
    expect(faster!.length).toBeCloseTo(500, -1);
    expect(slower!.length).toBeCloseTo(2000, -1);
  });

  it("clamps an out-of-range rate rather than producing an absurd length", () => {
    const channel = sineWave(100, 5);
    const [output] = changeSpeed([channel], { rate: 100 });
    expect(output!.length).toBeGreaterThan(0);
  });
});

describe("shiftPitch", () => {
  it("preserves the original duration", () => {
    const channel = sineWave(4096, 20);
    const [output] = shiftPitch([channel], { semitones: 7 });
    expect(output!.length).toBe(channel.length);
  });

  it("is a no-op copy at 0 semitones", () => {
    const channel = sineWave(500, 5);
    const [output] = shiftPitch([channel], { semitones: 0 });
    expect([...output!]).toEqual([...channel]);
    expect(output).not.toBe(channel); // a copy, not the same buffer
  });

  it("does not blow up amplitude (stays within a sane range for a unit-amplitude input)", () => {
    const channel = sineWave(4096, 15, 0.8);
    const [output] = shiftPitch([channel], { semitones: -5 });
    let peak = 0;
    for (const sample of output!) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeLessThan(1.5); // generous bound — OLA can overshoot slightly, but not blow up
  });
});

describe("applyPortableAudioEffect", () => {
  it("dispatches each portable effect id to its own function", () => {
    const channel = [Float32Array.from([1, 2, 3])];
    expect(applyPortableAudioEffect(channel, "reverse", {})![0]).toEqual(Float32Array.from([3, 2, 1]));
  });

  it("returns null for the four browser-only effect ids", () => {
    for (const id of ["eq", "compressor", "reverb", "delay"] as const) {
      expect(applyPortableAudioEffect([Float32Array.from([1])], id, {})).toBeNull();
    }
  });
});
