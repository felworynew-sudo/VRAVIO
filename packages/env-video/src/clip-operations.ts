/**
 * Clip move/trim/split/ripple constraint math — ported from `@vravio/env-audio`'s own
 * `clip-operations.ts` (itself ported from waveform-playlist, the donor named in
 * docs/master-plan.md §9.2), with samples replaced by frames throughout. The constraint math is
 * unit-agnostic — a clip on a timeline cannot go before 0 or overlap its neighbors whether the
 * position counter is samples or frames — so this is deliberately the same shape rather than a
 * shared generic: each environment package stays self-contained (docs/migration-plan.md §2), the
 * same reason raster and vector don't share a common "shape math" package either. All positions
 * are integers; every function here is a pure constraint calculation, no document mutation — the
 * caller (`video-commands.ts` in apps/web) applies the returned delta or split result to a
 * cloned document state.
 */
import type { VideoClip, VideoTransition, VideoTransitionCurve } from "./types";
import { createVideoClip } from "./document";

export const DEFAULT_MIN_DURATION_FRAMES_AT = (frameRate: number): number => Math.max(1, Math.floor(0.1 * frameRate));

function sortClipsByStart(clips: readonly VideoClip[]): VideoClip[] {
  return [...clips].sort((a, b) => a.startFrame - b.startFrame);
}

/**
 * Constrain a clip-drag delta so the clip cannot go before frame 0 or overlap its timeline
 * neighbors. `clip` must be a member of `sortedClips` (already sorted by `startFrame`) at
 * `clipIndex`.
 */
export function constrainClipDrag(clip: VideoClip, deltaFrames: number, sortedClips: readonly VideoClip[], clipIndex: number): number {
  let delta = deltaFrames;

  delta = Math.max(delta, -clip.startFrame);

  if (clipIndex > 0) {
    const previous = sortedClips[clipIndex - 1]!;
    delta = Math.max(delta, previous.startFrame + previous.durationFrames - clip.startFrame);
  }
  if (clipIndex < sortedClips.length - 1) {
    const next = sortedClips[clipIndex + 1]!;
    delta = Math.min(delta, next.startFrame - (clip.startFrame + clip.durationFrames));
  }
  return delta;
}

/** Convenience wrapper: sorts `trackClips` and locates `clip` before delegating to
 * `constrainClipDrag`. Callers that already have a sorted list and index should call
 * `constrainClipDrag` directly to avoid re-sorting on every drag frame. */
export function constrainClipDragOnTrack(clip: VideoClip, deltaFrames: number, trackClips: readonly VideoClip[]): number {
  const sorted = sortClipsByStart(trackClips);
  const index = sorted.findIndex((candidate) => candidate.id === clip.id);
  if (index === -1) return 0;
  return constrainClipDrag(clip, deltaFrames, sorted, index);
}

/**
 * Constrain a boundary-trim delta for one edge of a clip.
 *
 * LEFT: `startFrame += delta`, `offsetFrames += delta`, `durationFrames -= delta` — positive
 * delta shrinks the clip from the left, negative expands it (revealing more of the source,
 * bounded by 0).
 * RIGHT: `durationFrames += delta` — positive expands (bounded by the source's own length),
 * negative shrinks (bounded by `minDurationFrames`).
 *
 * `rippleFollowing` (right edge only): when true, the clamp against the next clip's `startFrame`
 * is skipped — the caller (`ripplePreviewTrimClip` in apps/web's `video-commands.ts`) is about to
 * shift every later clip on the track by this same delta, so there is no fixed boundary to stop
 * at. Left-edge trim never ripples: its own end position (`startFrame + durationFrames`) is
 * unchanged by construction (start moves one way, duration the other, by the same delta), so
 * there is nothing after it to shift — only the previous clip's boundary still applies, same as
 * non-ripple mode. (Identical reasoning to `@vravio/env-audio`'s own note on this, since the
 * math is the same shape.)
 */
export function constrainBoundaryTrim(clip: VideoClip, deltaFrames: number, boundary: "left" | "right", sortedClips: readonly VideoClip[], clipIndex: number, minDurationFrames: number, rippleFollowing = false): number {
  let delta = deltaFrames;

  if (boundary === "left") {
    delta = Math.max(delta, -clip.startFrame);
    delta = Math.max(delta, -clip.offsetFrames);
    if (clipIndex > 0) {
      const previous = sortedClips[clipIndex - 1]!;
      delta = Math.max(delta, previous.startFrame + previous.durationFrames - clip.startFrame);
    }
    delta = Math.min(delta, clip.durationFrames - minDurationFrames);
  } else {
    delta = Math.max(delta, minDurationFrames - clip.durationFrames);
    delta = Math.min(delta, clip.sourceDurationFrames - clip.offsetFrames - clip.durationFrames);
    if (!rippleFollowing && clipIndex < sortedClips.length - 1) {
      const next = sortedClips[clipIndex + 1]!;
      delta = Math.min(delta, next.startFrame - clip.startFrame - clip.durationFrames);
    }
  }
  return delta;
}

/** Whether `frame` is a valid interior split point for `clip` — strictly inside its bounds, with
 * both halves meeting `minDurationFrames`. */
export function canSplitAt(clip: VideoClip, frame: number, minDurationFrames: number): boolean {
  const end = clip.startFrame + clip.durationFrames;
  if (frame <= clip.startFrame || frame >= end) return false;
  const leftDuration = frame - clip.startFrame, rightDuration = end - frame;
  return leftDuration >= minDurationFrames && rightDuration >= minDurationFrames;
}

/** Splits `clip` into two at `splitFrame` (a timeline position). A hard cut on both halves —
 * unlike audio's fade-preserving split, video has no equivalent "carry the fade" concern in this
 * pass (transitions are a follow-up feature, docs/master-plan.md §9.1). */
export function splitClip(clip: VideoClip, splitFrame: number): { left: VideoClip; right: VideoClip } {
  const leftDuration = splitFrame - clip.startFrame;
  const rightDuration = clip.durationFrames - leftDuration;

  const left = createVideoClip(clip.assetId, leftDuration, clip.sourceDurationFrames, clip.sourceFrameRate, {
    name: clip.name, startFrame: clip.startFrame, offsetFrames: clip.offsetFrames, gain: clip.gain,
  });
  const right = createVideoClip(clip.assetId, rightDuration, clip.sourceDurationFrames, clip.sourceFrameRate, {
    name: clip.name, startFrame: splitFrame, offsetFrames: clip.offsetFrames + leftDuration, gain: clip.gain,
  });
  return { left, right };
}

/** Applies a left-boundary trim in place on a shallow copy of `clip`. */
export function applyLeftTrim(clip: VideoClip, delta: number): VideoClip {
  return { ...clip, startFrame: clip.startFrame + delta, offsetFrames: clip.offsetFrames + delta, durationFrames: clip.durationFrames - delta };
}

/** Applies a right-boundary trim in place on a shallow copy of `clip`. */
export function applyRightTrim(clip: VideoClip, delta: number): VideoClip {
  return { ...clip, durationFrames: clip.durationFrames + delta };
}

/**
 * Ripple editing: shifts every clip on `clips` that starts at or after `fromFrame` by
 * `deltaFrames` — negative to close a gap left by a delete/shrink, positive to open one for a
 * grow. Clamped so no clip's `startFrame` goes negative; a clip that starts exactly at
 * `fromFrame` is shifted too, same reasoning as `@vravio/env-audio`'s own `rippleShift`.
 *
 * Pure — returns a new array; the caller decides which tracks' clip arrays to pass in.
 */
export function rippleShift(clips: readonly VideoClip[], fromFrame: number, deltaFrames: number): VideoClip[] {
  if (deltaFrames === 0) return clips.map((clip) => ({ ...clip }));
  return clips.map((clip) => clip.startFrame >= fromFrame ? { ...clip, startFrame: Math.max(0, clip.startFrame + deltaFrames) } : { ...clip });
}

/** The largest fraction one crop edge may take without leaving less than 1% of the source
 * showing on that axis — the opposite edge's own crop already claims some of that axis. */
function maxCropForEdge(opposite: number): number {
  return Math.max(0, 0.99 - opposite);
}

/** Sets one crop edge on a shallow copy of `clip`, clamped to [0, 1] and against its opposite
 * edge so the two together never crop away the entire source on that axis (`compositor-math.ts`'s
 * `sourceRectFor` degenerates to a 1×1 rect rather than divide-by-zero if this were skipped, but
 * a source cropped down to one pixel is not a usable edit — this is the door that keeps it from
 * happening rather than relying on the renderer's own last-resort clamp). */
export function applyCropEdge(clip: VideoClip, edge: "left" | "top" | "right" | "bottom", value: number): VideoClip {
  const clamped01 = Math.max(0, Math.min(1, value));
  switch (edge) {
    case "left": return { ...clip, cropLeft: Math.min(clamped01, maxCropForEdge(clip.cropRight)) };
    case "right": return { ...clip, cropRight: Math.min(clamped01, maxCropForEdge(clip.cropLeft)) };
    case "top": return { ...clip, cropTop: Math.min(clamped01, maxCropForEdge(clip.cropBottom)) };
    case "bottom": return { ...clip, cropBottom: Math.min(clamped01, maxCropForEdge(clip.cropTop)) };
  }
}

/**
 * Snaps `candidateFrame` to the nearest value in `targets` within `thresholdFrames`, or returns
 * it unchanged if none is close enough — the same magnetism raster/vector already give the user
 * (`store.ts`'s `snapSensitivity`, converted from screen pixels to frames by the caller, the only
 * one who knows the current zoom) applied to clip edges instead of guide lines. Pure: which
 * targets to offer (other clips' starts/ends on the same track, the playhead, …) is the caller's
 * choice, not this function's.
 */
export function snapFrame(candidateFrame: number, targets: readonly number[], thresholdFrames: number): number {
  let closest = candidateFrame, closestDistance = thresholdFrames;
  for (const target of targets) {
    const distance = Math.abs(target - candidateFrame);
    if (distance <= closestDistance) { closest = target; closestDistance = distance; }
  }
  return closest;
}

/** Maps a linear 0..1 transition progress to the eased 0..1 blend weight for `curve` — the same
 * small set of named curves every donor NLE's transition Inspector offers. `easeInOut` is a
 * cosine ease (`(1-cos(πt))/2`), the standard smooth S-curve; `easeIn`/`easeOut` are its quadratic
 * cousins, cheap and visually indistinguishable from the fancier variants at transition lengths
 * short enough for a cut (well under a second, typically). */
export function applyTransitionCurve(curve: VideoTransitionCurve, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  switch (curve) {
    case "linear": return clamped;
    case "easeIn": return clamped * clamped;
    case "easeOut": return 1 - (1 - clamped) * (1 - clamped);
    case "easeInOut": return (1 - Math.cos(Math.PI * clamped)) / 2;
  }
}

/**
 * The eased 0 (all left clip) .. 1 (all right clip) blend weight for `transition` at absolute
 * timeline `frame` — 0 before the overlap starts, 1 once it ends, interpolated by the
 * transition's own curve in between. `rightClip` is the transition's own `rightClipId` clip
 * (its current `startFrame` is the overlap's start; the left clip's own `startFrame +
 * durationFrames`, computed by the caller, is the overlap's end).
 */
export function transitionBlendAt(transition: VideoTransition, rightClipStartFrame: number, overlapEndFrame: number, frame: number): number {
  const span = Math.max(1, overlapEndFrame - rightClipStartFrame);
  const t = (frame - rightClipStartFrame) / span;
  return applyTransitionCurve(transition.curve, t);
}
