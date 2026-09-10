import {
  addTake, applyLeftTrim, applyRightTrim, audioEffectCatalog, audioEffectDefaults, canPunchIn, canSplitAt, cloneAudioState,
  constrainBoundaryTrim, constrainClipDrag, createAudioBus, createAudioClip, createAudioCrossfade, createAudioMarker, createAudioTrack,
  cycleTake, decodeWav, encodeWav, punchInClip, removeAutomationPoint, rippleShift, setAutomationPoint, splitClip,
  type AudioDocumentState, type AudioEffectId, type FadeType,
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

/**
 * `ripple: true` (right edge only — see `constrainBoundaryTrim`'s own note on why left-edge
 * trim never ripples) lets the trim grow or shrink past where the next clip used to sit,
 * shifting every clip that started at or after this clip's *original* end position by the
 * same delta, so the gap this clip's edge just opened or closed is carried through instead of
 * hitting a hard stop at the neighbor.
 */
export function previewTrimClip(documentId: string, trackId: string, clipId: string, boundary: "left" | "right", deltaSamples: number, ripple = false): number {
  const document = kernel.documents.get<AudioDocumentState>(documentId);
  if (!document) return 0;
  const sorted = sortedClipsOf(document.state, trackId);
  const index = sorted.findIndex((clip) => clip.id === clipId);
  if (index === -1) return 0;
  const rippleFollowing = ripple && boundary === "right";
  const clip = sorted[index]!;
  const originalEnd = clip.startSample + clip.durationSamples;
  const constrained = constrainBoundaryTrim(clip, deltaSamples, boundary, sorted, index, minDurationSamples(document.state), rippleFollowing);
  if (constrained === 0) return 0;
  kernel.documents.update<AudioDocumentState>(documentId, (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const clipIndex = track?.clips.findIndex((item) => item.id === clipId) ?? -1;
    if (!track || clipIndex === -1) return;
    track.clips[clipIndex] = boundary === "left" ? applyLeftTrim(track.clips[clipIndex]!, constrained) : applyRightTrim(track.clips[clipIndex]!, constrained);
    if (rippleFollowing) {
      const others = track.clips.filter((item) => item.id !== clipId);
      const shifted = rippleShift(others, originalEnd, constrained);
      track.clips = [track.clips[clipIndex]!, ...shifted];
    }
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

export function setLoopEnabled(documentId: string, enabled: boolean): void {
  void changeAudioDocument(documentId, enabled ? "Enable Loop (Включить цикл)" : "Disable Loop (Выключить цикл)", (state) => {
    if (state.loopEnabled === enabled) return false;
    state.loopEnabled = enabled;
    return true;
  });
}

/** Ardour lets the loop range be dragged with playback already running, without a history
 * step per pixel — same "live write, one commit at gesture end" shape as `commitAudioDrag`
 * below, just for a document-level pair instead of a clip's. */
export function setLoopRegion(documentId: string, startSample: number, endSample: number): void {
  const document = kernel.documents.get<AudioDocumentState>(documentId);
  if (!document) return;
  const state = document.state;
  const start = Math.max(0, Math.min(startSample, endSample));
  const end = Math.max(start + 1, Math.max(startSample, endSample));
  kernel.documents.update<AudioDocumentState>(documentId, (current) => { current.loopStart = start; current.loopEnd = end; });
}

export function commitLoopRegion(documentId: string, before: AudioDocumentState): void {
  commitAudioDrag(documentId, "Set Loop Region (Задать границы цикла)", before);
}

export function setTempo(documentId: string, bpm: number): void {
  void changeAudioDocument(documentId, "Set Tempo (Задать темп)", (state) => {
    const clamped = Math.max(1, Math.min(999, bpm));
    if (state.bpm === clamped) return false;
    state.bpm = clamped;
    return true;
  });
}

export function setTimeSignature(documentId: string, numerator: number, denominator: number): void {
  void changeAudioDocument(documentId, "Set Time Signature (Задать размер такта)", (state) => {
    const num = Math.max(1, Math.min(32, Math.floor(numerator))), den = Math.max(1, Math.min(32, Math.floor(denominator)));
    if (state.timeSigNumerator === num && state.timeSigDenominator === den) return false;
    state.timeSigNumerator = num; state.timeSigDenominator = den;
    return true;
  });
}

// --- Crossfades (a real object between two adjacent clips, the same shape `VideoTransition`
// uses on the video side — docs/master-plan.md §33.2 priority 3's own "crossfade между клипами")

/**
 * Creates a crossfade between `leftClipId` and `rightClipId` on `trackId` — the two clips must be
 * exactly adjacent (the right clip's `startSample` equal to the left clip's own end). Overlaps
 * the right clip (and every later clip on the track) leftward by `durationSamples` via
 * `rippleShift`, the same one-pass overlap `video-commands.ts`'s `addTransition` creates.
 * `scheduleAudioGraph`'s own fade resolution (`apps/web/src/audioPlayback.ts`) treats a clip's
 * crossfade edge as replacing its manual fadeIn/fadeOut for that edge, not layering on top of it.
 */
export function addCrossfade(documentId: string, trackId: string, leftClipId: string, rightClipId: string, durationSamples: number, curve: FadeType = "linear"): void {
  void changeAudioDocument(documentId, "Add Crossfade (Добавить кроссфейд)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const left = track?.clips.find((item) => item.id === leftClipId);
    const right = track?.clips.find((item) => item.id === rightClipId);
    if (!track || !left || !right) return false;
    if (right.startSample !== left.startSample + left.durationSamples) return false; // not adjacent
    const clamped = Math.max(1, Math.min(durationSamples, left.durationSamples, right.durationSamples));
    track.clips = rippleShift(track.clips, right.startSample, -clamped);
    state.crossfades.push(createAudioCrossfade(trackId, leftClipId, rightClipId, clamped, curve));
    return true;
  });
}

/** Removes a crossfade's own record without restoring the overlap — the clips stay where the
 * crossfade left them, the same "the edit already happened" choice `removeTransition` makes on
 * the video side. */
export function removeCrossfade(documentId: string, crossfadeId: string): void {
  void changeAudioDocument(documentId, "Remove Crossfade (Убрать кроссфейд)", (state) => {
    const before = state.crossfades.length;
    state.crossfades = state.crossfades.filter((item) => item.id !== crossfadeId);
    return state.crossfades.length !== before;
  });
}

export function addMarker(documentId: string, sampleTime: number, name?: string): void {
  void changeAudioDocument(documentId, "Add Marker (Добавить маркер)", (state) => {
    const marker = createAudioMarker(name ?? `Marker ${state.markers.length + 1} (Маркер ${state.markers.length + 1})`, sampleTime);
    state.markers.push(marker);
    state.markers.sort((a, b) => a.sampleTime - b.sampleTime);
    return true;
  });
}

export function renameMarker(documentId: string, markerId: string, name: string): void {
  void changeAudioDocument(documentId, "Rename Marker (Переименовать маркер)", (state) => {
    const marker = state.markers.find((item) => item.id === markerId);
    if (!marker || marker.name === name) return false;
    marker.name = name;
    return true;
  });
}

export function removeMarker(documentId: string, markerId: string): void {
  void changeAudioDocument(documentId, "Delete Marker (Удалить маркер)", (state) => {
    const before = state.markers.length;
    state.markers = state.markers.filter((item) => item.id !== markerId);
    return state.markers.length !== before;
  });
}

export function addBus(documentId: string, name?: string): void {
  void changeAudioDocument(documentId, "Add Bus (Добавить шину)", (state) => {
    state.buses.push(createAudioBus(name ?? `Bus ${state.buses.length + 1} (Шина ${state.buses.length + 1})`));
    return true;
  });
}

export function removeBus(documentId: string, busId: string): void {
  void changeAudioDocument(documentId, "Delete Bus (Удалить шину)", (state) => {
    const before = state.buses.length;
    state.buses = state.buses.filter((bus) => bus.id !== busId);
    for (const track of state.tracks) track.sends = track.sends.filter((send) => send.busId !== busId);
    return state.buses.length !== before;
  });
}

export function renameBus(documentId: string, busId: string, name: string): void {
  void changeAudioDocument(documentId, "Rename Bus (Переименовать шину)", (state) => {
    const bus = state.buses.find((item) => item.id === busId);
    if (!bus || bus.name === name) return false;
    bus.name = name;
    return true;
  });
}

export function setBusVolume(documentId: string, busId: string, volume: number): void {
  kernel.documents.update<AudioDocumentState>(documentId, (state) => { const bus = state.buses.find((item) => item.id === busId); if (bus) bus.volume = Math.max(0, volume); });
}

export function setBusPan(documentId: string, busId: string, pan: number): void {
  kernel.documents.update<AudioDocumentState>(documentId, (state) => { const bus = state.buses.find((item) => item.id === busId); if (bus) bus.pan = Math.max(-1, Math.min(1, pan)); });
}

export function setBusMuted(documentId: string, busId: string, muted: boolean): void {
  void changeAudioDocument(documentId, muted ? "Mute Bus (Заглушить шину)" : "Unmute Bus (Включить шину)", (state) => {
    const bus = state.buses.find((item) => item.id === busId);
    if (!bus || bus.muted === muted) return false;
    bus.muted = muted;
    return true;
  });
}

export function setBusSoloed(documentId: string, busId: string, soloed: boolean): void {
  void changeAudioDocument(documentId, soloed ? "Solo Bus (Соло шины)" : "Unsolo Bus (Снять соло шины)", (state) => {
    const bus = state.buses.find((item) => item.id === busId);
    if (!bus || bus.soloed === soloed) return false;
    bus.soloed = soloed;
    return true;
  });
}

/** A track can hold at most one send to any given bus — a second send to the same bus is a
 * level adjustment on the first, not a new routing, matching Ardour's own aux-send panel. */
export function addSend(documentId: string, trackId: string, busId: string): void {
  void changeAudioDocument(documentId, "Add Send (Добавить посыл)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track || track.sends.some((send) => send.busId === busId)) return false;
    track.sends.push({ id: crypto.randomUUID(), busId, level: 0.5, enabled: true, pre: false });
    return true;
  });
}

export function removeSend(documentId: string, trackId: string, sendId: string): void {
  void changeAudioDocument(documentId, "Remove Send (Удалить посыл)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    const before = track.sends.length;
    track.sends = track.sends.filter((send) => send.id !== sendId);
    return track.sends.length !== before;
  });
}

export function setSendLevel(documentId: string, trackId: string, sendId: string, level: number): void {
  kernel.documents.update<AudioDocumentState>(documentId, (state) => { const send = state.tracks.find((item) => item.id === trackId)?.sends.find((item) => item.id === sendId); if (send) send.level = Math.max(0, level); });
}

export function setSendEnabled(documentId: string, trackId: string, sendId: string, enabled: boolean): void {
  void changeAudioDocument(documentId, enabled ? "Enable Send (Включить посыл)" : "Disable Send (Выключить посыл)", (state) => {
    const send = state.tracks.find((item) => item.id === trackId)?.sends.find((item) => item.id === sendId);
    if (!send || send.enabled === enabled) return false;
    send.enabled = enabled;
    return true;
  });
}

export function setSendPre(documentId: string, trackId: string, sendId: string, pre: boolean): void {
  void changeAudioDocument(documentId, pre ? "Pre-fader Send (Досылка до фейдера)" : "Post-fader Send (Досылка после фейдера)", (state) => {
    const send = state.tracks.find((item) => item.id === trackId)?.sends.find((item) => item.id === sendId);
    if (!send || send.pre === pre) return false;
    send.pre = pre;
    return true;
  });
}

export function moveMarker(documentId: string, markerId: string, sampleTime: number): void {
  const document = kernel.documents.get<AudioDocumentState>(documentId);
  if (!document) return;
  const marker = document.state.markers.find((item) => item.id === markerId);
  if (!marker) return;
  kernel.documents.update<AudioDocumentState>(documentId, (current) => {
    const found = current.markers.find((item) => item.id === markerId);
    if (found) found.sampleTime = Math.max(0, Math.round(sampleTime));
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
    if (track.effects.length === before) return false;
    // Nothing should be left automating a parameter of an effect that no longer exists —
    // automation.ts's own note on what a generic automation system needs to decide.
    const prefix = `${effectInstanceId}:`;
    for (const key of Object.keys(track.effectAutomation)) if (key.startsWith(prefix)) delete track.effectAutomation[key];
    return true;
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

/**
 * Records a fresh WAV asset as a new take on an existing clip, rather than a separate clip next
 * to it — what re-recording the same spot ("Retake") does, as opposed to `addClipFromAsset`'s
 * plain "record into empty space" path. The new take becomes active immediately.
 */
export async function addTakeToClip(documentId: string, trackId: string, clipId: string, assetId: string, sourceDurationSamples: number, sourceSampleRate: number): Promise<void> {
  await changeAudioDocument(documentId, "New Take (Новый дубль)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const clip = track?.clips.find((item) => item.id === clipId);
    if (!track || !clip) return false;
    Object.assign(clip, addTake(clip, { assetId, sourceDurationSamples, sourceSampleRate }));
    return true;
  });
  kernel.documents.addAssetRef(documentId, assetId as AssetId);
}

/** Cycles the selected clip's active take forward (`direction: 1`) or backward (`-1`), wrapping. */
export function cycleClipTake(documentId: string, trackId: string, clipId: string, direction: 1 | -1): void {
  void changeAudioDocument(documentId, "Switch Take (Сменить дубль)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip || clip.takes.length <= 1) return false;
    Object.assign(clip, cycleTake(clip, direction));
    return true;
  });
}

/**
 * Punches a freshly recorded WAV into `[fromSample, toSample)` of whichever clip on `trackId`
 * fully contains that range — splits it into up to three pieces (`punchInClip`, `@vravio/env-
 * audio`), replacing only the targeted span. Silently does nothing if no single clip covers the
 * whole punch range (a punch spanning two clips, or landing in a gap, isn't attempted — the
 * caller's own recording UI is responsible for only offering Punch where it applies).
 *
 * When the punch range is the covering clip's *entire* own span, this is really a whole-clip
 * retake rather than a partial punch — routed through `addTake` instead of `punchInClip` so the
 * clip keeps its identity and every take recorded onto it earlier, rather than `punchInClip`
 * building a brand-new clip object that would start a fresh, one-take history.
 */
export async function punchInRecording(documentId: string, trackId: string, fromSample: number, toSample: number, assetId: string, sourceDurationSamples: number, sourceSampleRate: number): Promise<boolean> {
  let applied = false;
  await changeAudioDocument(documentId, "Punch In (Punch-in запись)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    const clipIndex = track.clips.findIndex((item) => canPunchIn(item, fromSample, toSample));
    if (clipIndex === -1) return false;
    const clip = track.clips[clipIndex]!;
    if (fromSample === clip.startSample && toSample === clip.startSample + clip.durationSamples) {
      track.clips[clipIndex] = addTake(clip, { assetId, sourceDurationSamples, sourceSampleRate });
    } else {
      const { before, punched, after } = punchInClip(clip, fromSample, toSample, { assetId, sourceDurationSamples, sourceSampleRate });
      const replacement = [before, punched, after].filter((item) => item !== null);
      track.clips.splice(clipIndex, 1, ...replacement);
    }
    applied = true;
    return true;
  });
  if (applied) kernel.documents.addAssetRef(documentId, assetId as AssetId);
  return applied;
}

function effectAutomationKey(effectInstanceId: string, paramId: string): string { return `${effectInstanceId}:${paramId}`; }

/** The effect-parameter counterpart to `setTrackVolumeAutomationPoint` — same "same id across a
 * drag, fresh id for a new point" convention, just keyed to one effect instance's one parameter
 * instead of the track's fixed volume curve. */
export function setEffectParamAutomationPoint(documentId: string, trackId: string, effectInstanceId: string, paramId: string, pointId: string, time: number, value: number): void {
  void changeAudioDocument(documentId, "Effect Automation (Автоматизация эффекта)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    const key = effectAutomationKey(effectInstanceId, paramId);
    const points = removeAutomationPoint(track.effectAutomation[key] ?? [], pointId);
    track.effectAutomation[key] = setAutomationPoint(points, time, value, pointId);
    return true;
  });
}

export function removeEffectParamAutomationPoint(documentId: string, trackId: string, effectInstanceId: string, paramId: string, pointId: string): void {
  void changeAudioDocument(documentId, "Remove Automation Point (Удалить точку автоматизации)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const key = effectAutomationKey(effectInstanceId, paramId);
    const points = track?.effectAutomation[key];
    if (!track || !points || points.length === 0) return false;
    const next = removeAutomationPoint(points, pointId);
    if (next.length === 0) delete track.effectAutomation[key]; else track.effectAutomation[key] = next;
    return next.length !== points.length;
  });
}

export function clearEffectParamAutomation(documentId: string, trackId: string, effectInstanceId: string, paramId: string): void {
  void changeAudioDocument(documentId, "Clear Automation (Очистить автоматизацию)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const key = effectAutomationKey(effectInstanceId, paramId);
    if (!track || !track.effectAutomation[key]) return false;
    delete track.effectAutomation[key];
    return true;
  });
}
