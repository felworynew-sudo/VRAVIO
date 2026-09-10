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

/** One recorded alternative for a clip's audible content — Reaper/Logic's own "takes" model,
 * kept minimal: each take is just an asset reference plus the two fields needed to bound a trim
 * against it, the same triple `AudioClip` itself already carries for whichever take is active. */
export interface AudioTake {
  readonly assetId: string;
  readonly sourceDurationSamples: number;
  readonly sourceSampleRate: number;
}

export interface AudioClip {
  readonly id: string;
  name: string;
  /** Reference into the shared asset store — a clip never carries its own decoded audio here,
   * the same "asset, not a copy" rule raster layers and vector image shapes follow. Always equal
   * to `takes[activeTakeIndex].assetId` — kept as its own field (rather than derived on every
   * read) because every existing consumer of a clip — playback, waveform rendering, export —
   * already reads `assetId`/`sourceDurationSamples`/`sourceSampleRate` directly and none of them
   * need to know takes exist at all. */
  assetId: string;
  /** Position on the timeline, in samples at the document's sample rate. */
  startSample: number;
  /** Length on the timeline, in samples at the document's sample rate. */
  durationSamples: number;
  /** Trim-in: how far into the decoded source this clip's audible region begins, in samples
   * at the *source's own* sample rate (see `sourceSampleRate`). */
  offsetSamples: number;
  /** Full length of the decoded source, in samples at the source's own sample rate — the
   * right-edge trim bound (a clip cannot extend past what its source actually contains). Mirrors
   * `takes[activeTakeIndex].sourceDurationSamples`. */
  sourceDurationSamples: number;
  /** The decoded source's native sample rate. Equal to the document's sample rate for audio
   * imported at the project rate; different when a source needs resampling to play in sync.
   * Mirrors `takes[activeTakeIndex].sourceSampleRate`. */
  sourceSampleRate: number;
  /** Every take recorded onto this clip's timeline position, oldest first — always at least one
   * entry (the take `assetId` currently mirrors). Re-recording the same spot (`audio-
   * commands.ts`'s `addClipFromAsset`/recording flow) appends rather than replacing, so nothing
   * already captured is lost by punching in again. */
  takes: readonly AudioTake[];
  /** Which entry of `takes` this clip currently plays — `assetId`/`sourceDurationSamples`/
   * `sourceSampleRate` are kept in sync with `takes[activeTakeIndex]` by every writer. */
  activeTakeIndex: number;
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

/**
 * One aux send from a track to a bus — Ardour/Audacity 4's own "aux send", a tap of a track's
 * signal routed to a sub-mix independent of its main output to master. `level` a linear gain
 * multiplier on the tapped copy, same unit `AudioTrack.volume` uses.
 *
 * `pre` names the intended tap point (pre-fader: before the track's own volume/pan; post-fader:
 * after, the same signal already headed to master) but the engine's first pass
 * (`apps/web/src/audioPlayback.ts`'s `scheduleAudioGraph`) taps every send post-fader regardless
 * — an honest, documented simplification (this field exists so a saved send does not lose the
 * user's intent once pre-fader tapping is actually wired), not a silent stand-in.
 */
export interface AudioSend {
  readonly id: string;
  busId: string;
  level: number;
  enabled: boolean;
  pre: boolean;
}

/**
 * A sub-mix that receives only from track sends, never directly from clips — Ardour's own
 * "bus": a reverb send everyone shares, a stem for "all drums," a headphone mix. Its own output
 * always joins the master bus; nothing routes bus-to-bus in this first pass (Ardour allows it,
 * and so will this once a real need for it shows up — CLAUDE.md's own rule against contract
 * grown ahead of a caller that needs it).
 */
export interface AudioBus {
  readonly id: string;
  name: string;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  effects: AudioTrackEffect[];
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
  /**
   * Per-effect-parameter automation, generalizing `volumeAutomation`'s own curve shape to an
   * arbitrary control on an arbitrary effect instance — the extension `automation.ts`'s own doc
   * comment named as needing "a way to name and address a parameter on an arbitrary effect
   * instance" before it could exist. Keyed `${AudioTrackEffect.id}:${paramId}` (both halves
   * needed: a track can carry more than one instance of the same effect). Curves for an effect
   * that gets removed (`audio-commands.ts`'s `removeTrackEffect`) are deleted along with it —
   * the answer `automation.ts` asked for to "what happens to a lane when the effect it targets
   * is removed": nothing left pointing at an id that no longer exists. */
  effectAutomation: Record<string, AutomationPoint[]>;
  sends: AudioSend[];
}

export interface AudioSelection {
  readonly trackId: string;
  readonly clipIds: readonly string[];
}

/** A named point on the timeline — Ardour/Audacity's own "marker", used for song sections,
 * edit-drop points and punch references alike. `sampleTime` in the document's own sample rate,
 * same unit every other timeline position in this file uses. */
export interface AudioMarker {
  readonly id: string;
  name: string;
  sampleTime: number;
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
  /**
   * One project-wide tempo and time signature — not yet Ardour's own tempo *map* (a sorted list
   * of tempo/meter change points with ramped or constant segments between them, `docs/master-
   * plan.md` §33.2's own next slice for this). A single value is what Audacity's transport and
   * GarageBand's project settings both actually are — an honest scope match for what this
   * engine's bar ruler/grid-snap need today, not a silent stand-in for the harder version.
   */
  bpm: number;
  timeSigNumerator: number;
  timeSigDenominator: number;
  markers: AudioMarker[];
  buses: AudioBus[];
}

export interface AudioDocumentOptions {
  sampleRate?: number;
  channels?: 1 | 2;
  bitDepth?: 16 | 24 | 32;
}
