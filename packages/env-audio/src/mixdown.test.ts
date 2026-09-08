import { describe, expect, it } from "vitest";
import { createAudioClip, createAudioDocument, createAudioTrack } from "./document";
import { mixdownAudioDocument, type AudioSourceLookup } from "./mixdown";

function constantSource(value: number, length: number, sampleRate = 48000): { channelData: Float32Array[]; sampleRate: number } {
  return { channelData: [new Float32Array(length).fill(value)], sampleRate };
}

describe("mixdownAudioDocument", () => {
  it("places a single clip at its timeline position", () => {
    const state = createAudioDocument({ channels: 1 });
    const clip = createAudioClip("a", 100, 100, 48000, { startSample: 50 });
    state.tracks[0]!.clips.push(clip);
    const lookup: AudioSourceLookup = () => constantSource(0.5, 100);

    const [output] = mixdownAudioDocument(state, lookup);
    // The rendered buffer is exactly as long as the timeline (last clip's end) — there is no
    // trailing silence to sample past index 149.
    expect(output).toHaveLength(150);
    expect(output![0]).toBeCloseTo(0, 5); // before the clip starts
    expect(output![49]).toBeCloseTo(0, 5);
    expect(output![50]).toBeCloseTo(0.5, 2); // clip start
    expect(output![149]).toBeCloseTo(0.5, 2); // clip end
  });

  it("applies clip gain and track volume multiplicatively", () => {
    const state = createAudioDocument({ channels: 1 });
    state.tracks[0]!.volume = 0.5;
    state.tracks[0]!.clips.push(createAudioClip("a", 50, 50, 48000, { gain: 0.5 }));
    const [output] = mixdownAudioDocument(state, () => constantSource(1, 50));
    expect(output![10]).toBeCloseTo(0.25, 2); // 1 * 0.5 gain * 0.5 volume
  });

  it("silences a muted track", () => {
    const state = createAudioDocument({ channels: 1 });
    state.tracks[0]!.muted = true;
    state.tracks[0]!.clips.push(createAudioClip("a", 50, 50, 48000));
    const [output] = mixdownAudioDocument(state, () => constantSource(1, 50));
    expect(output!.every((sample) => sample === 0)).toBe(true);
  });

  it("solo silences every non-soloed track", () => {
    const state = createAudioDocument({ channels: 1 });
    const soloed = state.tracks[0]!;
    soloed.soloed = true;
    soloed.clips.push(createAudioClip("a", 50, 50, 48000));
    const quiet = createAudioTrack();
    quiet.clips.push(createAudioClip("b", 50, 50, 48000));
    state.tracks.push(quiet);

    const [output] = mixdownAudioDocument(state, () => constantSource(1, 50));
    expect(output![10]).toBeCloseTo(1, 2); // only the soloed track's constant(1) source
  });

  it("applies fade-in and fade-out envelopes", () => {
    const state = createAudioDocument({ channels: 1 });
    state.tracks[0]!.clips.push(createAudioClip("a", 100, 100, 48000, { fadeInSamples: 20, fadeOutSamples: 20 }));
    const [output] = mixdownAudioDocument(state, () => constantSource(1, 100));
    expect(output![0]).toBeCloseTo(0, 1); // fade-in start
    expect(output![19]).toBeGreaterThan(0.8); // fade-in nearly complete
    expect(output![50]).toBeCloseTo(1, 2); // full volume in the middle
    expect(output![99]).toBeLessThan(0.2); // fade-out end
  });

  it("skips a clip whose asset cannot be resolved, rather than throwing", () => {
    const state = createAudioDocument({ channels: 1 });
    state.tracks[0]!.clips.push(createAudioClip("missing", 50, 50, 48000));
    expect(() => mixdownAudioDocument(state, () => undefined)).not.toThrow();
  });

  it("pans a mono source across a stereo mix", () => {
    const state = createAudioDocument({ channels: 2 });
    state.tracks[0]!.pan = -1; // full left
    state.tracks[0]!.clips.push(createAudioClip("a", 50, 50, 48000));
    const [left, right] = mixdownAudioDocument(state, () => constantSource(1, 50));
    expect(left![10]).toBeGreaterThan(0.9);
    expect(right![10]).toBeCloseTo(0, 2);
  });

  it("respects masterVolume as a final multiplier", () => {
    const state = createAudioDocument({ channels: 1 });
    state.masterVolume = 0.5;
    state.tracks[0]!.clips.push(createAudioClip("a", 50, 50, 48000));
    const [output] = mixdownAudioDocument(state, () => constantSource(1, 50));
    expect(output![10]).toBeCloseTo(0.5, 2);
  });
});
