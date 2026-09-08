/**
 * Clip move/trim/split constraint math — ported from waveform-playlist's
 * `packages/engine/src/operations/clipOperations.ts` (MIT), the donor named in
 * docs/master-plan.md §9.2 for VRAVIO's own web/React stack. All positions are in samples
 * (integers); every function here is a pure constraint calculation, no document mutation —
 * the caller (`document-edits.ts` in apps/web, mirroring the raster/vector convention) applies
 * the returned delta or split result to a cloned document state.
 */
import type { AudioClip } from "./types";
import { createAudioClip } from "./document";

export const DEFAULT_MIN_DURATION_SAMPLES_AT = (sampleRate: number): number => Math.floor(0.1 * sampleRate);

function sortClipsByStart(clips: readonly AudioClip[]): AudioClip[] {
  return [...clips].sort((a, b) => a.startSample - b.startSample);
}

/**
 * Constrain a clip-drag delta so the clip cannot go before sample 0 or overlap its
 * timeline neighbors. `clip` must be a member of `sortedClips` (already sorted by
 * `startSample`) at `clipIndex`.
 */
export function constrainClipDrag(clip: AudioClip, deltaSamples: number, sortedClips: readonly AudioClip[], clipIndex: number): number {
  let delta = deltaSamples;

  delta = Math.max(delta, -clip.startSample);

  if (clipIndex > 0) {
    const previous = sortedClips[clipIndex - 1]!;
    delta = Math.max(delta, previous.startSample + previous.durationSamples - clip.startSample);
  }
  if (clipIndex < sortedClips.length - 1) {
    const next = sortedClips[clipIndex + 1]!;
    delta = Math.min(delta, next.startSample - (clip.startSample + clip.durationSamples));
  }
  return delta;
}

/** Convenience wrapper: sorts `trackClips` and locates `clip` before delegating to
 * `constrainClipDrag`. Callers that already have a sorted list and index should call
 * `constrainClipDrag` directly to avoid re-sorting on every drag frame. */
export function constrainClipDragOnTrack(clip: AudioClip, deltaSamples: number, trackClips: readonly AudioClip[]): number {
  const sorted = sortClipsByStart(trackClips);
  const index = sorted.findIndex((candidate) => candidate.id === clip.id);
  if (index === -1) return 0;
  return constrainClipDrag(clip, deltaSamples, sorted, index);
}

/**
 * Constrain a boundary-trim delta for one edge of a clip.
 *
 * LEFT: `startSample += delta`, `offsetSamples += delta`, `durationSamples -= delta` —
 * positive delta shrinks the clip from the left, negative expands it (revealing more of the
 * source, bounded by 0).
 * RIGHT: `durationSamples += delta` — positive expands (bounded by the source's own length),
 * negative shrinks (bounded by `minDurationSamples`).
 */
export function constrainBoundaryTrim(clip: AudioClip, deltaSamples: number, boundary: "left" | "right", sortedClips: readonly AudioClip[], clipIndex: number, minDurationSamples: number): number {
  let delta = deltaSamples;

  if (boundary === "left") {
    delta = Math.max(delta, -clip.startSample);
    delta = Math.max(delta, -clip.offsetSamples);
    if (clipIndex > 0) {
      const previous = sortedClips[clipIndex - 1]!;
      delta = Math.max(delta, previous.startSample + previous.durationSamples - clip.startSample);
    }
    delta = Math.min(delta, clip.durationSamples - minDurationSamples);
  } else {
    delta = Math.max(delta, minDurationSamples - clip.durationSamples);
    delta = Math.min(delta, clip.sourceDurationSamples - clip.offsetSamples - clip.durationSamples);
    if (clipIndex < sortedClips.length - 1) {
      const next = sortedClips[clipIndex + 1]!;
      delta = Math.min(delta, next.startSample - clip.startSample - clip.durationSamples);
    }
  }
  return delta;
}

/** Whether `sample` is a valid interior split point for `clip` — strictly inside its bounds,
 * with both halves meeting `minDurationSamples`. */
export function canSplitAt(clip: AudioClip, sample: number, minDurationSamples: number): boolean {
  const end = clip.startSample + clip.durationSamples;
  if (sample <= clip.startSample || sample >= end) return false;
  const leftDuration = sample - clip.startSample, rightDuration = end - sample;
  return leftDuration >= minDurationSamples && rightDuration >= minDurationSamples;
}

/**
 * Splits `clip` into two at `splitSample` (a timeline position). The left half keeps the
 * original fade-in, the right half keeps the original fade-out; the cut edge itself gets no
 * fade on either side (a hard cut, matching the donor's own behavior — a crossfade at the cut
 * is a deliberate follow-up action, not implied by splitting).
 */
export function splitClip(clip: AudioClip, splitSample: number): { left: AudioClip; right: AudioClip } {
  const leftDuration = splitSample - clip.startSample;
  const rightDuration = clip.durationSamples - leftDuration;

  const left = createAudioClip(clip.assetId, leftDuration, clip.sourceDurationSamples, clip.sourceSampleRate, {
    name: clip.name, startSample: clip.startSample, offsetSamples: clip.offsetSamples, gain: clip.gain,
    fadeInSamples: clip.fadeInSamples, fadeOutSamples: 0, fadeType: clip.fadeType,
  });
  const right = createAudioClip(clip.assetId, rightDuration, clip.sourceDurationSamples, clip.sourceSampleRate, {
    name: clip.name, startSample: splitSample, offsetSamples: clip.offsetSamples + leftDuration, gain: clip.gain,
    fadeInSamples: 0, fadeOutSamples: clip.fadeOutSamples, fadeType: clip.fadeType,
  });
  return { left, right };
}

/** Applies a left-boundary trim in place on a shallow copy of `clip`. */
export function applyLeftTrim(clip: AudioClip, delta: number): AudioClip {
  return { ...clip, startSample: clip.startSample + delta, offsetSamples: clip.offsetSamples + delta, durationSamples: clip.durationSamples - delta };
}

/** Applies a right-boundary trim in place on a shallow copy of `clip`. */
export function applyRightTrim(clip: AudioClip, delta: number): AudioClip {
  return { ...clip, durationSamples: clip.durationSamples + delta };
}
