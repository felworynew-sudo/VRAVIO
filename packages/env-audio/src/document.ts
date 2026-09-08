import type { AudioClip, AudioDocumentOptions, AudioDocumentState, AudioTrack, FadeType } from "./types";

export function createAudioTrack(name = "Track 1 (Дорожка 1)"): AudioTrack {
  return { id: crypto.randomUUID(), name, volume: 1, pan: 0, muted: false, soloed: false, locked: false, clips: [], effects: [] };
}

export interface CreateAudioClipOptions {
  readonly name?: string;
  readonly startSample?: number;
  readonly offsetSamples?: number;
  readonly gain?: number;
  readonly fadeInSamples?: number;
  readonly fadeOutSamples?: number;
  readonly fadeType?: FadeType;
}

export function createAudioClip(assetId: string, durationSamples: number, sourceDurationSamples: number, sourceSampleRate: number, options: CreateAudioClipOptions = {}): AudioClip {
  return {
    id: crypto.randomUUID(),
    name: options.name ?? "Clip (Клип)",
    assetId,
    startSample: Math.max(0, Math.floor(options.startSample ?? 0)),
    durationSamples: Math.max(0, Math.floor(durationSamples)),
    offsetSamples: Math.max(0, Math.floor(options.offsetSamples ?? 0)),
    sourceDurationSamples: Math.max(0, Math.floor(sourceDurationSamples)),
    sourceSampleRate,
    gain: options.gain ?? 1,
    fadeInSamples: Math.max(0, Math.floor(options.fadeInSamples ?? 0)),
    fadeOutSamples: Math.max(0, Math.floor(options.fadeOutSamples ?? 0)),
    fadeType: options.fadeType ?? "linear",
  };
}

export function createAudioDocument(options: AudioDocumentOptions = {}): AudioDocumentState {
  const track = createAudioTrack();
  return {
    kind: "audio", schemaVersion: 1,
    sampleRate: options.sampleRate ?? 48000, channels: options.channels ?? 2, bitDepth: options.bitDepth ?? 24,
    tracks: [track], activeTrackId: track.id, selection: null,
    masterVolume: 1, loopStart: 0, loopEnd: 0, loopEnabled: false,
  };
}

export function isAudioDocumentState(value: unknown): value is AudioDocumentState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AudioDocumentState>;
  if (candidate.kind !== "audio" || candidate.schemaVersion !== 1 || !Array.isArray(candidate.tracks) || typeof candidate.sampleRate !== "number") return false;
  migrateAudioDocumentState(candidate as AudioDocumentState);
  return true;
}

/** In-place and idempotent, same convention as `migrateRasterDocumentState` — a session
 * persisted before a track carried its own effect stack restores with one added, rather than
 * failing `isAudioDocumentState` (and thus refusing to open) the moment a field is missing. */
export function migrateAudioDocumentState(state: AudioDocumentState): AudioDocumentState {
  for (const track of state.tracks) if (!Array.isArray(track.effects)) track.effects = [];
  return state;
}

/**
 * A document snapshot cheap enough to take on every structural edit — same shape as
 * `cloneRasterState`/vector's own clone helper: shallow across what dominates memory (there is
 * nothing large here; clips carry no PCM, only an `assetId` reference), deep enough that
 * mutating one snapshot's clip array never bleeds into the other's.
 */
export function cloneAudioState(state: AudioDocumentState): AudioDocumentState {
  return {
    ...state,
    tracks: state.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip })), effects: track.effects.map((effect) => ({ ...effect, params: { ...effect.params } })) })),
    selection: state.selection ? { trackId: state.selection.trackId, clipIds: [...state.selection.clipIds] } : null,
  };
}

export function findTrack(state: AudioDocumentState, trackId: string): AudioTrack | undefined {
  return state.tracks.find((track) => track.id === trackId);
}

export function findClip(state: AudioDocumentState, trackId: string, clipId: string): AudioClip | undefined {
  return findTrack(state, trackId)?.clips.find((clip) => clip.id === clipId);
}

/** End of the last clip across every track, in samples — the timeline's own length. */
export function timelineDurationSamples(state: AudioDocumentState): number {
  let end = 0;
  for (const track of state.tracks) for (const clip of track.clips) end = Math.max(end, clip.startSample + clip.durationSamples);
  return end;
}
