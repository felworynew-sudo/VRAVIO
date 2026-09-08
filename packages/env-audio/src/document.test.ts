import { describe, expect, it } from "vitest";
import { cloneAudioState, createAudioClip, createAudioDocument, createAudioTrack, findClip, findTrack, isAudioDocumentState, timelineDurationSamples } from "./document";

describe("createAudioDocument", () => {
  it("starts with one empty track and sane defaults", () => {
    const state = createAudioDocument();
    expect(state.kind).toBe("audio");
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0]!.clips).toHaveLength(0);
    expect(state.activeTrackId).toBe(state.tracks[0]!.id);
    expect(state.sampleRate).toBe(48000);
    expect(state.channels).toBe(2);
    expect(isAudioDocumentState(state)).toBe(true);
  });

  it("honors explicit sample rate/channels/bit depth", () => {
    const state = createAudioDocument({ sampleRate: 44100, channels: 1, bitDepth: 16 });
    expect(state.sampleRate).toBe(44100);
    expect(state.channels).toBe(1);
    expect(state.bitDepth).toBe(16);
  });
});

describe("isAudioDocumentState", () => {
  it("rejects non-audio and malformed values", () => {
    expect(isAudioDocumentState(null)).toBe(false);
    expect(isAudioDocumentState({ kind: "raster" })).toBe(false);
    expect(isAudioDocumentState({ kind: "audio", schemaVersion: 1 })).toBe(false); // no tracks/sampleRate
  });
});

describe("clip and track creation", () => {
  it("creates a track with unique id and default mixer state", () => {
    const a = createAudioTrack(), b = createAudioTrack();
    expect(a.id).not.toBe(b.id);
    expect(a.volume).toBe(1);
    expect(a.pan).toBe(0);
    expect(a.muted).toBe(false);
    expect(a.soloed).toBe(false);
  });

  it("creates a clip referencing an asset with defaults", () => {
    const clip = createAudioClip("asset-1", 1000, 5000, 48000);
    expect(clip.assetId).toBe("asset-1");
    expect(clip.durationSamples).toBe(1000);
    expect(clip.sourceDurationSamples).toBe(5000);
    expect(clip.startSample).toBe(0);
    expect(clip.offsetSamples).toBe(0);
    expect(clip.gain).toBe(1);
    expect(clip.fadeInSamples).toBe(0);
    expect(clip.fadeType).toBe("linear");
  });
});

describe("findTrack / findClip", () => {
  it("locates a track and clip by id", () => {
    const state = createAudioDocument();
    const track = state.tracks[0]!;
    const clip = createAudioClip("asset-1", 100, 100, 48000);
    track.clips.push(clip);
    expect(findTrack(state, track.id)).toBe(track);
    expect(findClip(state, track.id, clip.id)).toBe(clip);
    expect(findClip(state, track.id, "missing")).toBeUndefined();
  });
});

describe("timelineDurationSamples", () => {
  it("is the end of the latest clip across every track", () => {
    const state = createAudioDocument();
    const [trackA] = state.tracks;
    const trackB = createAudioTrack();
    state.tracks.push(trackB);
    trackA!.clips.push(createAudioClip("a", 1000, 1000, 48000, { startSample: 0 }));
    trackB.clips.push(createAudioClip("b", 500, 500, 48000, { startSample: 2000 }));
    expect(timelineDurationSamples(state)).toBe(2500);
  });

  it("is zero for an empty document", () => {
    expect(timelineDurationSamples(createAudioDocument())).toBe(0);
  });
});

describe("cloneAudioState", () => {
  it("deep-copies tracks/clips/selection so mutating the clone leaves the original untouched", () => {
    const state = createAudioDocument();
    state.tracks[0]!.clips.push(createAudioClip("a", 100, 100, 48000));
    state.selection = { trackId: state.tracks[0]!.id, clipIds: [state.tracks[0]!.clips[0]!.id] };

    const clone = cloneAudioState(state);
    clone.tracks[0]!.clips[0]!.gain = 0.5;
    clone.selection!.clipIds.push("extra");
    clone.tracks.push(createAudioTrack());

    expect(state.tracks[0]!.clips[0]!.gain).toBe(1);
    expect(state.selection!.clipIds).toHaveLength(1);
    expect(state.tracks).toHaveLength(1);
  });
});
