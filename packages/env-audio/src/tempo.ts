import type { AudioDocumentState } from "./types";

/** A position on the musical grid, 1-indexed the way every DAW transport reads it (bar 1, beat
 * 1 is the very start — not 0.0, the way `startSample` counts). */
export interface BarBeat {
  readonly bar: number;
  readonly beat: number;
}

/** Samples per beat at the document's one project tempo — `timeSigDenominator` decides what a
 * "beat" is (a quarter note in 4/4, an eighth in 6/8), the same reading Ardour's own tempo gives
 * `note_type`: a beat here is always one `timeSigDenominator`-th note, at `bpm` of them a minute. */
export function samplesPerBeat(state: AudioDocumentState): number {
  return (state.sampleRate * 60) / state.bpm;
}

export function samplesPerBar(state: AudioDocumentState): number {
  return samplesPerBeat(state) * state.timeSigNumerator;
}

export function sampleToBarBeat(state: AudioDocumentState, sample: number): BarBeat {
  const perBeat = samplesPerBeat(state);
  // `barBeatToSample` rounds a fractional sample position to the nearest whole sample — the only
  // kind a timeline has — so up to half a sample of that rounding can survive the round trip
  // (95 BPM's beat is never a whole number of samples). Nudged back by that same half-sample,
  // in beat units, before flooring: a beat that landed exactly on its boundary before rounding
  // reads one beat short after it otherwise, confirmed by round-tripping every bar/beat this
  // module's own test exercises, not assumed.
  const beats = Math.max(0, sample) / perBeat + 0.5 / perBeat;
  const bar = Math.floor(beats / state.timeSigNumerator);
  const beatInBar = beats - bar * state.timeSigNumerator;
  return { bar: bar + 1, beat: Math.floor(beatInBar) + 1 };
}

export function barBeatToSample(state: AudioDocumentState, position: BarBeat): number {
  const beats = (position.bar - 1) * state.timeSigNumerator + (position.beat - 1);
  return Math.round(beats * samplesPerBeat(state));
}

export function formatBarBeat(position: BarBeat): string {
  return `${position.bar}.${position.beat}`;
}

/** The nearest bar line to `sample` — grid-snap's own primitive, Ardour's "snap to bar". */
export function nearestBarSample(state: AudioDocumentState, sample: number): number {
  const perBar = samplesPerBar(state);
  return Math.max(0, Math.round(sample / perBar) * perBar);
}

/** The nearest beat line — one grid finer than a bar, Ardour's "snap to beat". */
export function nearestBeatSample(state: AudioDocumentState, sample: number): number {
  const perBeat = samplesPerBeat(state);
  return Math.max(0, Math.round(sample / perBeat) * perBeat);
}
