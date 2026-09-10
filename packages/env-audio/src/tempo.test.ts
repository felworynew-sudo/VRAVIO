import { describe, expect, it } from "vitest";
import { createAudioDocument } from "./document";
import { barBeatToSample, formatBarBeat, nearestBarSample, nearestBeatSample, sampleToBarBeat, samplesPerBar, samplesPerBeat } from "./tempo";

describe("tempo/time-signature bar math", () => {
  it("gives a sample rate over BPM the samples-per-beat everyone expects", () => {
    const state = createAudioDocument({ sampleRate: 48000 });
    state.bpm = 120;
    // 120 BPM = 2 beats/second, so one beat is exactly half a second.
    expect(samplesPerBeat(state)).toBe(24000);
    expect(samplesPerBar(state)).toBe(24000 * state.timeSigNumerator);
  });

  it("reads bar 1 beat 1 at the very start of the timeline", () => {
    const state = createAudioDocument({ sampleRate: 48000 });
    expect(sampleToBarBeat(state, 0)).toEqual({ bar: 1, beat: 1 });
  });

  it("advances one full bar in 4/4 after four beats", () => {
    const state = createAudioDocument({ sampleRate: 48000 });
    state.bpm = 120; state.timeSigNumerator = 4;
    const oneBeat = samplesPerBeat(state);
    expect(sampleToBarBeat(state, oneBeat)).toEqual({ bar: 1, beat: 2 });
    expect(sampleToBarBeat(state, oneBeat * 3)).toEqual({ bar: 1, beat: 4 });
    expect(sampleToBarBeat(state, oneBeat * 4)).toEqual({ bar: 2, beat: 1 });
  });

  it("respects a non-4 time signature — 3/4 rolls over to the next bar after three beats", () => {
    const state = createAudioDocument({ sampleRate: 48000 });
    state.bpm = 120; state.timeSigNumerator = 3;
    const oneBeat = samplesPerBeat(state);
    expect(sampleToBarBeat(state, oneBeat * 2)).toEqual({ bar: 1, beat: 3 });
    expect(sampleToBarBeat(state, oneBeat * 3)).toEqual({ bar: 2, beat: 1 });
  });

  it("round-trips sample -> bar/beat -> sample", () => {
    const state = createAudioDocument({ sampleRate: 48000 });
    state.bpm = 95; state.timeSigNumerator = 4;
    for (const bar of [1, 2, 5, 13]) for (const beat of [1, 2, 3, 4]) {
      const sample = barBeatToSample(state, { bar, beat });
      expect(sampleToBarBeat(state, sample)).toEqual({ bar, beat });
    }
  });

  it("formats as bar.beat, the transport readout's own convention", () => {
    expect(formatBarBeat({ bar: 3, beat: 2 })).toBe("3.2");
  });

  it("snaps to the nearest bar or beat line", () => {
    const state = createAudioDocument({ sampleRate: 48000 });
    state.bpm = 120; // one beat = 24000 samples, one bar (4/4) = 96000 samples
    expect(nearestBarSample(state, 50000)).toBe(96000);
    expect(nearestBarSample(state, 40000)).toBe(0);
    expect(nearestBeatSample(state, 30000)).toBe(24000);
    expect(nearestBeatSample(state, 10000)).toBe(0);
  });

  it("never snaps to a negative sample", () => {
    const state = createAudioDocument({ sampleRate: 48000 });
    expect(nearestBarSample(state, 0)).toBe(0);
    expect(nearestBeatSample(state, 0)).toBe(0);
  });
});
