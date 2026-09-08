import {
  applyLeftTrim, applyRightTrim, audioEffectCatalog, audioEffectDefaults, canSplitAt, cloneAudioState, constrainBoundaryTrim,
  constrainClipDrag, createAudioClip, createAudioTrack, decodeWav, encodeWav, removeAutomationPoint, rippleShift,
  setAutomationPoint, splitClip, type AudioDocumentState, type AudioEffectId, type FadeType,
} from "@vravio/env-audio";
import type { AssetId } from "@vravio/kernel";
import { kernel } from "./kernel";
import { applyAudioEffect } from "./audioEffects";

const MIN_CLIP_DURATION_SECONDS = 0.1;

function minDurationSamples(state: AudioDocumentState): number {
  return Math.max(1, Math.floor(MIN_CLIP_DURATION_SECONDS * state.sampleRate));
}

function assignAudioState(documentId: string, snapshot: AudioDocumentState): void {
  kernel.documents.update<AudioDocumentState>(documentId, (state) => { Object.assign(state, cloneAudioState(snapshot)); });
}

/**
 * The audio equivalent of `changeVectorDocument`/`changeRasterDocument` — snapshot, mutate a
 * draft, diff, one history step. `mutate` returns `false` for a no-op (nothing found, a
 * constrained delta of 0) so a click that changes nothing doesn't leave a phantom undo entry.
 */
export async function changeAudioDocument(documentId: string, label: string, mutate: (state: AudioDocumentState) => boolean): Promise<void> {
  const document = kernel.documents.get<AudioDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history) return;
  const before = cloneAudioState(document.state);
  const working = cloneAudioState(document.state);
  if (!mutate(working)) return;
  const after = cloneAudioState(working);
  await history.execute({ label, memoryEstimate: 0, redo: () => assignAudioState(documentId, after), undo: () => assignAudioState(documentId, before) });
}

/** Records one history step for a drag already applied live via `kernel.documents.update` on
 * every pointermove — `before` must be captured at pointerdown, ahead of any of those writes. */
export function commitAudioDrag(documentId: string, label: string, before: AudioDocumentState): void {
  const document = kernel.documents.get<AudioDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history) return;
  const after = cloneAudioState(document.state);
  void history.record({ label, redo: () => assignAudioState(documentId, after), undo: () => assignAudioState(documentId, before) });
}

function sortedClipsOf(state: AudioDocumentState, trackId: string) {
  const track = state.tracks.find((item) => item.id === trackId);
  return track ? [...track.clips].sort((a, b) => a.startSample - b.startSample) : [];
}

/** Live drag preview — called on every pointermove, writes straight to the document so the
 * clip visibly follows the pointer; the caller commits one history step at pointerup via
 * `commitAudioDrag`. Returns the delta actually applied (0 if fully constrained). */
export function previewMoveClip(documentId: string, trackId: string, clipId: string, deltaSamples: number): number {
  const document = kernel.documents.get<AudioDocumentState>(documentId);
  if (!document) return 0;
  const sorted = sortedClipsOf(document.state, trackId);
  const index = sorted.findIndex((clip) => clip.id === clipId);
  if (index === -1) return 0;
  const constrained = constrainClipDrag(sorted[index]!, deltaSamples, sorted, index);
  if (constrained === 0) return 0;
  kernel.documents.update<AudioDocumentState>(documentId, (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (clip) clip.startSample += constrained;
  });
  return constrained;
}

export function previewTrimClip(documentId: string, trackId: string, clipId: string, boundary: "left" | "right", deltaSamples: number): number {
  const document = kernel.documents.get<AudioDocumentState>(documentId);
  if (!document) return 0;
  const sorted = sortedClipsOf(document.state, trackId);
  const index = sorted.findIndex((clip) => clip.id === clipId);
  if (index === -1) return 0;
  const constrained = constrainBoundaryTrim(sorted[index]!, deltaSamples, boundary, sorted, index, minDurationSamples(document.state));
  if (constrained === 0) return 0;
  kernel.documents.update<AudioDocumentState>(documentId, (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const clipIndex = track?.clips.findIndex((item) => item.id === clipId) ?? -1;
    if (!track || clipIndex === -1) return;
    track.clips[clipIndex] = boundary === "left" ? applyLeftTrim(track.clips[clipIndex]!, constrained) : applyRightTrim(track.clips[clipIndex]!, constrained);
  });
  return constrained;
}

export function splitClipAt(documentId: string, trackId: string, clipId: string, atSample: number): void {
  void changeAudioDocument(documentId, "Split Clip (Разрезать клип)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const clipIndex = track?.clips.findIndex((item) => item.id === clipId) ?? -1;
    if (!track || clipIndex === -1) return false;
    const clip = track.clips[clipIndex]!;
    if (!canSplitAt(clip, atSample, minDurationSamples(state))) return false;
    const { left, right } = splitClip(clip, atSample);
    track.clips.splice(clipIndex, 1, left, right);
    return true;
  });
}

/**
 * Deletes the selected clip(s). `ripple: true` closes the gap each deletion leaves by shifting
 * every later clip on the same track left by the deleted clip's duration — Audacity's own
 * "Ripple Delete" (docs/master-plan.md §9.2's Audacity-4 phase). Multiple selected clips are
 * processed in timeline order so each deletion's gap closes before the next one is considered,
 * the same as deleting them one at a time would.
 */
export function deleteSelectedClips(documentId: string, ripple = false): void {
  void changeAudioDocument(documentId, ripple ? "Ripple Delete (Удалить со сдвигом)" : "Delete Clip (Удалить клип)", (state) => {
    if (!state.selection) return false;
    const track = state.tracks.find((item) => item.id === state.selection!.trackId);
    if (!track) return false;
    const before = track.clips.length;
    const toDelete = track.clips.filter((clip) => state.selection!.clipIds.includes(clip.id)).sort((a, b) => a.startSample - b.startSample);
    if (toDelete.length === 0) return false;

    if (ripple) {
      for (const clip of toDelete) {
        const remaining = track.clips.filter((item) => item.id !== clip.id);
        track.clips = rippleShift(remaining, clip.startSample + clip.durationSamples, -clip.durationSamples);
      }
    } else {
      track.clips = track.clips.filter((clip) => !state.selection!.clipIds.includes(clip.id));
    }
    state.selection = null;
    return track.clips.length !== before;
  });
}

export function setClipGain(documentId: string, trackId: string, clipId: string, gain: number): void {
  void changeAudioDocument(documentId, "Clip Gain (Громкость клипа)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip) return false;
    clip.gain = Math.max(0, gain);
    return true;
  });
}

export function setClipFade(documentId: string, trackId: string, clipId: string, edge: "in" | "out", samples: number, fadeType?: FadeType): void {
  void changeAudioDocument(documentId, edge === "in" ? "Fade In (Плавное появление)" : "Fade Out (Плавное затухание)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip) return false;
    const clamped = Math.max(0, Math.min(clip.durationSamples, Math.floor(samples)));
    if (edge === "in") clip.fadeInSamples = clamped; else clip.fadeOutSamples = clamped;
    if (fadeType) clip.fadeType = fadeType;
    return true;
  });
}

export function setTrackVolume(documentId: string, trackId: string, volume: number): void {
  void changeAudioDocument(documentId, "Track Volume (Громкость дорожки)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.volume = Math.max(0, volume);
    return true;
  });
}

export function setTrackPan(documentId: string, trackId: string, pan: number): void {
  void changeAudioDocument(documentId, "Track Pan (Панорама дорожки)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.pan = Math.max(-1, Math.min(1, pan));
    return true;
  });
}

export function setTrackMuted(documentId: string, trackId: string, muted: boolean): void {
  void changeAudioDocument(documentId, muted ? "Mute Track (Заглушить дорожку)" : "Unmute Track (Включить дорожку)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.muted = muted;
    return true;
  });
}

export function setTrackSoloed(documentId: string, trackId: string, soloed: boolean): void {
  void changeAudioDocument(documentId, soloed ? "Solo Track (Соло дорожки)" : "Unsolo Track (Снять соло)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.soloed = soloed;
    return true;
  });
}

export function setTrackLocked(documentId: string, trackId: string, locked: boolean): void {
  void changeAudioDocument(documentId, locked ? "Lock Track (Заблокировать дорожку)" : "Unlock Track (Разблокировать дорожку)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.locked = locked;
    return true;
  });
}

export function addAudioTrack(documentId: string, name?: string): void {
  void changeAudioDocument(documentId, "New Track (Новая дорожка)", (state) => { state.tracks.push(createAudioTrack(name)); return true; });
}

export function removeAudioTrack(documentId: string, trackId: string): void {
  void changeAudioDocument(documentId, "Delete Track (Удалить дорожку)", (state) => {
    if (state.tracks.length <= 1) return false; // always leave at least one track
    const before = state.tracks.length;
    state.tracks = state.tracks.filter((track) => track.id !== trackId);
    if (state.activeTrackId === trackId) state.activeTrackId = state.tracks[0]!.id;
    return state.tracks.length !== before;
  });
}

export function setSelection(documentId: string, trackId: string | null, clipIds: readonly string[]): void {
  kernel.documents.update<AudioDocumentState>(documentId, (state) => {
    state.selection = trackId && clipIds.length ? { trackId, clipIds } : null;
  });
}

/** Places a decoded-and-encoded WAV asset as a new clip at `startSample` on `trackId` (a new
 * track if none is given) — the import path's document-side half; decoding the user's file and
 * encoding it to WAV happens in `audioImport.ts`, upstream of this call. */
export async function addClipFromAsset(documentId: string, assetId: string, name: string, durationSamples: number, sourceSampleRate: number, trackId?: string, startSample = 0): Promise<void> {
  await changeAudioDocument(documentId, "Import Audio (Импортировать аудио)", (state) => {
    const track = trackId ? state.tracks.find((item) => item.id === trackId) : createAudioTrack(name);
    if (!track) return false;
    if (!trackId) state.tracks.push(track);
    track.clips.push(createAudioClip(assetId, durationSamples, durationSamples, sourceSampleRate, { name, startSample }));
    return true;
  });
  kernel.documents.addAssetRef(documentId, assetId as AssetId);
}

/**
 * Applies a destructive effect (`packages/env-audio`'s `audioEffectCatalog`) to a clip's
 * audible window — the region actually heard, `[offsetSamples, offsetSamples + durationSamples
 * worth of source samples)`, not the whole decoded source, the same "process the clip, not the
 * file" scope Audacity/AudioMass apply an effect at. The processed audio becomes a brand-new
 * WAV asset (never mutates the asset another clip might still reference) and the clip is
 * repointed at it with `offsetSamples: 0` — the new asset *is* exactly the processed window,
 * there is nothing before or after it to trim to.
 *
 * Asset creation happens before `changeAudioDocument` (which must stay synchronous — its
 * `mutate` runs once against a plain draft, not an async generator), the same ordering
 * `addClipFromAsset` already uses for `addAssetRef`.
 */
export interface ClipAudioWindow {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly clipName: string;
}

/** Decodes the audible window of a clip — the region actually heard, not the
 * whole source file. The read half of every destructive clip operation
 * (effects, and a plugin through `environments/audio/plugins/surface.ts`), so
 * there is one definition of "what a clip's audio is" rather than one per
 * caller. */
export async function readClipAudioWindow(documentId: string, trackId: string, clipId: string): Promise<ClipAudioWindow | null> {
  const document = kernel.documents.get<AudioDocumentState>(documentId);
  const clip = document?.state.tracks.find((track) => track.id === trackId)?.clips.find((item) => item.id === clipId);
  if (!document || !clip) return null;

  const bytes = await kernel.assets.read(clip.assetId as AssetId);
  if (!bytes) return null;
  const decoded = decodeWav(bytes);
  const sourceWindowLength = Math.round((clip.durationSamples * clip.sourceSampleRate) / document.state.sampleRate);
  return {
    channels: decoded.channelData.map((channel) => channel.slice(clip.offsetSamples, clip.offsetSamples + sourceWindowLength)),
    sampleRate: clip.sourceSampleRate,
    clipName: clip.name,
  };
}

/**
 * Writes processed audio back into a clip: a brand-new WAV asset (never
 * mutating one another clip might still reference) with the clip repointed at
 * it, `offsetSamples: 0` — the new asset *is* exactly the processed window, so
 * there is nothing before or after it to trim to. The write half shared by
 * effects and plugins; audio's single door, in the sense
 * `RasterWorkspace.tsx`'s `commitPixels` is raster's.
 */
export async function replaceClipAudio(documentId: string, trackId: string, clipId: string, channels: readonly Float32Array[], sampleRate: number, label: string): Promise<void> {
  const document = kernel.documents.get<AudioDocumentState>(documentId);
  if (!document) return;
  const processedLength = channels[0]?.length ?? 0;
  const newTimelineDuration = Math.max(1, Math.round((processedLength * document.state.sampleRate) / sampleRate));

  const wav = encodeWav(channels, sampleRate, 32);
  const assetId = await kernel.assets.importAsset(wav, { kind: "audio", mime: "audio/wav", name: `${label}.wav` });

  await changeAudioDocument(documentId, label, (state) => {
    const target = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!target) return false;
    target.assetId = assetId;
    target.offsetSamples = 0;
    target.sourceDurationSamples = processedLength;
    target.durationSamples = newTimelineDuration;
    return true;
  });
  kernel.documents.addAssetRef(documentId, assetId as AssetId);
}

export async function applyEffectToClip(documentId: string, trackId: string, clipId: string, effectId: AudioEffectId, params: Record<string, number>): Promise<void> {
  const window = await readClipAudioWindow(documentId, trackId, clipId);
  if (!window) return;
  const processed = await applyAudioEffect(window.channels, window.sampleRate, effectId, params);
  await replaceClipAudio(documentId, trackId, clipId, processed, window.sampleRate, `${window.clipName} (${effectId})`);
}

// --- Realtime track effect stack (docs/master-plan.md §9.2's Audacity-4 phase) ---------------
//
// Only a `portable: false` catalog entry (eq/compressor/reverb/delay) can go on a track's live
// stack — the other five are one-shot destructive transforms with no meaning as something a
// listener rides continuously. This module is the one door: nothing else appends to
// `track.effects`, so this is the only place that guard has to live.

function isRealtimeEffect(effectId: AudioEffectId): boolean {
  return audioEffectCatalog.find((definition) => definition.id === effectId)?.portable === false;
}

export function addTrackEffect(documentId: string, trackId: string, effectId: AudioEffectId): void {
  if (!isRealtimeEffect(effectId)) return;
  void changeAudioDocument(documentId, "Add Effect (Добавить эффект)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.effects.push({ id: crypto.randomUUID(), effectId, params: audioEffectDefaults(effectId), enabled: true });
    return true;
  });
}

export function removeTrackEffect(documentId: string, trackId: string, effectInstanceId: string): void {
  void changeAudioDocument(documentId, "Remove Effect (Удалить эффект)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    const before = track.effects.length;
    track.effects = track.effects.filter((effect) => effect.id !== effectInstanceId);
    return track.effects.length !== before;
  });
}

export function setTrackEffectEnabled(documentId: string, trackId: string, effectInstanceId: string, enabled: boolean): void {
  void changeAudioDocument(documentId, enabled ? "Enable Effect (Включить эффект)" : "Disable Effect (Выключить эффект)", (state) => {
    const effect = state.tracks.find((item) => item.id === trackId)?.effects.find((item) => item.id === effectInstanceId);
    if (!effect) return false;
    effect.enabled = enabled;
    return true;
  });
}

export function setTrackEffectParam(documentId: string, trackId: string, effectInstanceId: string, paramId: string, value: number): void {
  void changeAudioDocument(documentId, "Effect Parameter (Параметр эффекта)", (state) => {
    const effect = state.tracks.find((item) => item.id === trackId)?.effects.find((item) => item.id === effectInstanceId);
    if (!effect) return false;
    effect.params[paramId] = value;
    return true;
  });
}

/** Moves an effect earlier (`direction: -1`) or later (`+1`) in the track's insert order —
 * order matters for a series chain (EQ before compression sounds different from after). */
export function reorderTrackEffect(documentId: string, trackId: string, effectInstanceId: string, direction: -1 | 1): void {
  void changeAudioDocument(documentId, "Reorder Effect (Переставить эффект)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    const index = track.effects.findIndex((effect) => effect.id === effectInstanceId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= track.effects.length) return false;
    const [effect] = track.effects.splice(index, 1);
    track.effects.splice(target, 0, effect!);
    return true;
  });
}

// --- Track volume automation (docs/master-plan.md §9.2's Audacity-4 phase) -------------------

/** Places (or moves an existing point at the same time to) a breakpoint on a track's volume
 * curve. `pointId` names the point being edited — pass the same id across a drag gesture so
 * moving one point updates it in place instead of leaving a trail of new ones; pass a fresh id
 * for a genuinely new point. */
export function setTrackVolumeAutomationPoint(documentId: string, trackId: string, pointId: string, time: number, value: number): void {
  void changeAudioDocument(documentId, "Volume Automation (Автоматизация громкости)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.volumeAutomation = removeAutomationPoint(track.volumeAutomation, pointId);
    track.volumeAutomation = setAutomationPoint(track.volumeAutomation, time, Math.max(0, value), pointId);
    return true;
  });
}

export function removeTrackVolumeAutomationPoint(documentId: string, trackId: string, pointId: string): void {
  void changeAudioDocument(documentId, "Remove Automation Point (Удалить точку автоматизации)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    const before = track.volumeAutomation.length;
    track.volumeAutomation = removeAutomationPoint(track.volumeAutomation, pointId);
    return track.volumeAutomation.length !== before;
  });
}

export function clearTrackVolumeAutomation(documentId: string, trackId: string): void {
  void changeAudioDocument(documentId, "Clear Automation (Очистить автоматизацию)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track || track.volumeAutomation.length === 0) return false;
    track.volumeAutomation = [];
    return true;
  });
}
