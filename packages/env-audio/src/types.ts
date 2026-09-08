/**
 * Positions and lengths are in samples at the document's own `sampleRate`, not seconds —
 * the same reasoning waveform-playlist's engine gives for its own `AudioClip`: sample counts
 * are exact integers, seconds accumulate floating-point drift over a long edit session and
 * make "does this clip start exactly where the last one ended" an epsilon comparison instead
 * of `===`.
 */

import type { AudioEffectId } from "./effects";

export type FadeType = "linear" | "exponential" | "sCurve" | "logarithmic";

/**
 * One insert in a track's realtime effect stack (docs/master-plan.md §9.2's Audacity-4 phase).
 * `effectId` must name a `portable: false` catalog entry (eq/compressor/reverb/delay) — the
 * other five effects are one-shot destructive transforms (normalize a buffer once, reverse it
 * once), not something a listener could "ride" continuously the way a live compressor knob
 * is; `audio-commands.ts`'s `addTrackEffect` is the one door that enforces this before a
 * non-realtime effect id could ever land in this array.
 */
export interface AudioTrackEffect {
  readonly id: string;
  readonly effectId: AudioEffectId;
  params: Record<string, number>;
  enabled: boolean;
}

export interface AudioClip {
  readonly id: string;
  name: string;
  /** Reference into the shared asset store — a clip never carries its own decoded audio here,
   * the same "asset, not a copy" rule raster layers and vector image shapes follow. */
  assetId: string;
  /** Position on the timeline, in samples at the document's sample rate. */
  startSample: number;
  /** Length on the timeline, in samples at the document's sample rate. */
  durationSamples: number;
  /** Trim-in: how far into the decoded source this clip's audible region begins, in samples
   * at the *source's own* sample rate (see `sourceSampleRate`). */
  offsetSamples: number;
  /** Full length of the decoded source, in samples at the source's own sample rate — the
   * right-edge trim bound (a clip cannot extend past what its source actually contains). */
  sourceDurationSamples: number;
  /** The decoded source's native sample rate. Equal to the document's sample rate for audio
   * imported at the project rate; different when a source needs resampling to play in sync. */
  sourceSampleRate: number;
  /** Linear gain multiplier, 1 = unity (0 dB). */
  gain: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  fadeType: FadeType;
}

/** One breakpoint of a track's volume automation — `time` in samples at the document's sample
 * rate, `value` a linear gain multiplier (1 = unity), same units as `AudioTrack.volume` itself
 * so a point and the static fallback are directly comparable. */
export interface AutomationPoint {
  readonly id: string;
  time: number;
  value: number;
}

export interface AudioTrack {
  readonly id: string;
  name: string;
  /** Linear volume multiplier, 1 = unity (0 dB) — the static value used when
   * `volumeAutomation` is empty, and the held level before the first point/after the last one
   * when it isn't (an automation lane replaces the fader over the *range it covers*, not
   * forever — Tracktion Engine's own model, cited at the top of §9.2, keeps a track's static
   * value meaningful even once it carries an automation lane, for exactly this reason). */
  volume: number;
  /** -1 (full left) .. 1 (full right), 0 = center. */
  pan: number;
  muted: boolean;
  soloed: boolean;
  locked: boolean;
  clips: AudioClip[];
  effects: AudioTrackEffect[];
  /** Sorted by `time` ascending — every writer (`audio-commands.ts`) maintains that order so a
   * reader never has to sort before walking the curve. */
  volumeAutomation: AutomationPoint[];
}

export interface AudioSelection {
  readonly trackId: string;
  readonly clipIds: readonly string[];
}

export interface AudioDocumentState {
  kind: "audio";
  schemaVersion: 1;
  sampleRate: number;
  channels: 1 | 2;
  bitDepth: 16 | 24 | 32;
  tracks: AudioTrack[];
  activeTrackId: string;
  selection: AudioSelection | null;
  masterVolume: number;
  loopStart: number;
  loopEnd: number;
  loopEnabled: boolean;
}

export interface AudioDocumentOptions {
  sampleRate?: number;
  channels?: 1 | 2;
  bitDepth?: 16 | 24 | 32;
}
