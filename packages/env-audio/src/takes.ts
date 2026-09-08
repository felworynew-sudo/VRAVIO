/**
 * Multiple-takes editing (docs/master-plan.md §9.2's Audacity-4 phase, "advanced recording" —
 * the item explicitly left undone at the end of that pass). Pure functions, same shape as
 * `clip-operations.ts`: no document mutation, the caller (`audio-commands.ts` in apps/web)
 * applies the result to a cloned document state.
 */
import type { AudioClip, AudioTake } from "./types";
import { createAudioClip } from "./document";

/** Clamps `offsetSamples`/`durationSamples` against `take`'s own source length — a shorter take
 * than the one it replaces would otherwise leave the clip pointing at samples past the end of
 * its new source (the same clamp `relinkTarget` already applies when a clip's asset changes
 * underneath it — this is that same situation, just chosen by the user instead of an asset
 * revision). Shared by `addTake` and `setActiveTake`: both end with a different take active, so
 * both need the same bound applied to whatever is left of the clip's own timeline window. */
function withTakeApplied(clip: AudioClip, index: number, take: AudioTake): AudioClip {
  const offsetSamples = Math.min(clip.offsetSamples, take.sourceDurationSamples);
  const durationSamples = Math.min(clip.durationSamples, take.sourceDurationSamples - offsetSamples);
  return { ...clip, activeTakeIndex: index, assetId: take.assetId, sourceDurationSamples: take.sourceDurationSamples, sourceSampleRate: take.sourceSampleRate, offsetSamples, durationSamples };
}

/** Appends a new take and makes it the active one — punching in again at the same spot never
 * loses what was already recorded there, the same reasoning `AudioClip.takes`'s own doc comment
 * gives for keeping every take rather than overwriting. */
export function addTake(clip: AudioClip, take: AudioTake): AudioClip {
  const takes = [...clip.takes, take];
  return withTakeApplied({ ...clip, takes }, takes.length - 1, take);
}

/** Switches which take plays. */
export function setActiveTake(clip: AudioClip, index: number): AudioClip {
  if (index < 0 || index >= clip.takes.length) return clip;
  return withTakeApplied(clip, index, clip.takes[index]!);
}

/** The next take in cycle order, wrapping — what a "Next Take" button calls. */
export function cycleTake(clip: AudioClip, direction: 1 | -1): AudioClip {
  if (clip.takes.length <= 1) return clip;
  const next = (clip.activeTakeIndex + direction + clip.takes.length) % clip.takes.length;
  return setActiveTake(clip, next);
}

/** Whether `[fromSample, toSample)` can be punched into `clip` — strictly inside its bounds
 * (a punch spanning past either edge would need to touch the *neighboring* clip too, which this
 * single-clip function deliberately does not do — a punch that overruns is a job for the caller
 * to reject and ask the user to select a narrower range, the same "no" `canSplitAt` already gives
 * for an out-of-bounds split). */
export function canPunchIn(clip: AudioClip, fromSample: number, toSample: number): boolean {
  const end = clip.startSample + clip.durationSamples;
  return fromSample >= clip.startSample && toSample <= end && toSample > fromSample;
}

/**
 * Re-records `[fromSample, toSample)` of `clip`'s timeline span with `take` — the "punch-in"
 * half of advanced recording: everything outside the punched range is untouched (not even
 * re-created as a new clip object, so its own identity, name and fades survive), and the punched
 * range becomes its own new clip carrying just the new take. Splits into up to three pieces —
 * `before`/`punched`/`after` — the same shape `splitClip` already gives for a plain two-way cut,
 * just twice.
 */
export function punchInClip(clip: AudioClip, fromSample: number, toSample: number, take: AudioTake): { before: AudioClip | null; punched: AudioClip; after: AudioClip | null } {
  const clipEnd = clip.startSample + clip.durationSamples;
  const before = fromSample > clip.startSample
    ? { ...clip, durationSamples: fromSample - clip.startSample }
    : null;
  const after = toSample < clipEnd
    ? { ...clip, id: crypto.randomUUID(), startSample: toSample, offsetSamples: clip.offsetSamples + (toSample - clip.startSample), durationSamples: clipEnd - toSample }
    : null;
  const punched = createAudioClip(take.assetId, toSample - fromSample, take.sourceDurationSamples, take.sourceSampleRate, {
    name: clip.name, startSample: fromSample, gain: clip.gain,
  });
  return { before, punched, after };
}
