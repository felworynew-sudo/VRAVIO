import {
  applyLeftTrim, applyRightTrim, canSplitAt, cloneVideoState, constrainBoundaryTrim, constrainClipDrag,
  createVideoClip, createVideoTrack, rippleShift, splitClip, type VideoDocumentState,
} from "@vravio/env-video";
import type { AssetId } from "@vravio/kernel";
import { kernel } from "./kernel";

const MIN_CLIP_DURATION_SECONDS = 0.1;

function minDurationFrames(state: VideoDocumentState): number {
  return Math.max(1, Math.floor(MIN_CLIP_DURATION_SECONDS * state.frameRate));
}

function assignVideoState(documentId: string, snapshot: VideoDocumentState): void {
  kernel.documents.update<VideoDocumentState>(documentId, (state) => { Object.assign(state, cloneVideoState(snapshot)); });
}

/** The video equivalent of `changeAudioDocument`/`changeRasterDocument` — snapshot, mutate a
 * draft, diff, one history step. `mutate` returns `false` for a no-op so a click that changes
 * nothing doesn't leave a phantom undo entry. */
export async function changeVideoDocument(documentId: string, label: string, mutate: (state: VideoDocumentState) => boolean): Promise<void> {
  const document = kernel.documents.get<VideoDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history) return;
  const before = cloneVideoState(document.state);
  const working = cloneVideoState(document.state);
  if (!mutate(working)) return;
  const after = cloneVideoState(working);
  await history.execute({ label, memoryEstimate: 0, redo: () => assignVideoState(documentId, after), undo: () => assignVideoState(documentId, before) });
}

/** Records one history step for a drag already applied live via `kernel.documents.update` on
 * every pointermove — `before` must be captured at pointerdown, ahead of any of those writes. */
export function commitVideoDrag(documentId: string, label: string, before: VideoDocumentState): void {
  const document = kernel.documents.get<VideoDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history) return;
  const after = cloneVideoState(document.state);
  void history.record({ label, redo: () => assignVideoState(documentId, after), undo: () => assignVideoState(documentId, before) });
}

function sortedClipsOf(state: VideoDocumentState, trackId: string) {
  const track = state.tracks.find((item) => item.id === trackId);
  return track ? [...track.clips].sort((a, b) => a.startFrame - b.startFrame) : [];
}

/** Live drag preview — called on every pointermove, writes straight to the document so the clip
 * visibly follows the pointer; the caller commits one history step at pointerup via
 * `commitVideoDrag`. Returns the delta actually applied (0 if fully constrained). */
export function previewMoveClip(documentId: string, trackId: string, clipId: string, deltaFrames: number): number {
  const document = kernel.documents.get<VideoDocumentState>(documentId);
  if (!document) return 0;
  const sorted = sortedClipsOf(document.state, trackId);
  const index = sorted.findIndex((clip) => clip.id === clipId);
  if (index === -1) return 0;
  const constrained = constrainClipDrag(sorted[index]!, deltaFrames, sorted, index);
  if (constrained === 0) return 0;
  kernel.documents.update<VideoDocumentState>(documentId, (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (clip) clip.startFrame += constrained;
  });
  return constrained;
}

/** `ripple: true` (right edge only — see `constrainBoundaryTrim`'s own note on why left-edge
 * trim never ripples, packages/env-video/src/clip-operations.ts) lets the trim grow or shrink
 * past where the next clip used to sit, shifting every clip that started at or after this clip's
 * *original* end position by the same delta — the same behavior `audio-commands.ts`'s own
 * `previewTrimClip` gives audio clips. */
export function previewTrimClip(documentId: string, trackId: string, clipId: string, boundary: "left" | "right", deltaFrames: number, ripple = false): number {
  const document = kernel.documents.get<VideoDocumentState>(documentId);
  if (!document) return 0;
  const sorted = sortedClipsOf(document.state, trackId);
  const index = sorted.findIndex((clip) => clip.id === clipId);
  if (index === -1) return 0;
  const rippleFollowing = ripple && boundary === "right";
  const clip = sorted[index]!;
  const originalEnd = clip.startFrame + clip.durationFrames;
  const constrained = constrainBoundaryTrim(clip, deltaFrames, boundary, sorted, index, minDurationFrames(document.state), rippleFollowing);
  if (constrained === 0) return 0;
  kernel.documents.update<VideoDocumentState>(documentId, (state) => {
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

export function splitClipAt(documentId: string, trackId: string, clipId: string, atFrame: number): void {
  void changeVideoDocument(documentId, "Split Clip (Разрезать клип)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const clipIndex = track?.clips.findIndex((item) => item.id === clipId) ?? -1;
    if (!track || clipIndex === -1) return false;
    const clip = track.clips[clipIndex]!;
    if (!canSplitAt(clip, atFrame, minDurationFrames(state))) return false;
    const { left, right } = splitClip(clip, atFrame);
    track.clips.splice(clipIndex, 1, left, right);
    return true;
  });
}

/** Deletes the selected clip(s). `ripple: true` closes the gap each deletion leaves by shifting
 * every later clip on the same track left by the deleted clip's duration (same behavior as
 * `audio-commands.ts`'s own `deleteSelectedClips`). Multiple selected clips are processed in
 * timeline order so each deletion's gap closes before the next one is considered. */
export function deleteSelectedClips(documentId: string, ripple = false): void {
  void changeVideoDocument(documentId, ripple ? "Ripple Delete (Удалить со сдвигом)" : "Delete Clip (Удалить клип)", (state) => {
    if (!state.selection) return false;
    const track = state.tracks.find((item) => item.id === state.selection!.trackId);
    if (!track) return false;
    const before = track.clips.length;
    const toDelete = track.clips.filter((clip) => state.selection!.clipIds.includes(clip.id)).sort((a, b) => a.startFrame - b.startFrame);
    if (toDelete.length === 0) return false;

    if (ripple) {
      for (const clip of toDelete) {
        const remaining = track.clips.filter((item) => item.id !== clip.id);
        track.clips = rippleShift(remaining, clip.startFrame + clip.durationFrames, -clip.durationFrames);
      }
    } else {
      track.clips = track.clips.filter((clip) => !state.selection!.clipIds.includes(clip.id));
    }
    state.selection = null;
    return track.clips.length !== before;
  });
}

export function setTrackVolume(documentId: string, trackId: string, volume: number): void {
  void changeVideoDocument(documentId, "Track Volume (Громкость дорожки)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.volume = Math.max(0, volume);
    return true;
  });
}

export function setTrackMuted(documentId: string, trackId: string, muted: boolean): void {
  void changeVideoDocument(documentId, muted ? "Mute Track (Заглушить дорожку)" : "Unmute Track (Включить дорожку)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.muted = muted;
    return true;
  });
}

export function setTrackHidden(documentId: string, trackId: string, hidden: boolean): void {
  void changeVideoDocument(documentId, hidden ? "Hide Track (Скрыть дорожку)" : "Show Track (Показать дорожку)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.hidden = hidden;
    return true;
  });
}

export function setTrackLocked(documentId: string, trackId: string, locked: boolean): void {
  void changeVideoDocument(documentId, locked ? "Lock Track (Заблокировать дорожку)" : "Unlock Track (Разблокировать дорожку)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) return false;
    track.locked = locked;
    return true;
  });
}

export function addVideoTrack(documentId: string, kind: "video" | "audio", name?: string): void {
  void changeVideoDocument(documentId, kind === "video" ? "New Video Track (Новая видеодорожка)" : "New Audio Track (Новая аудиодорожка)", (state) => { state.tracks.push(createVideoTrack(kind, name)); return true; });
}

export function removeVideoTrack(documentId: string, trackId: string): void {
  void changeVideoDocument(documentId, "Delete Track (Удалить дорожку)", (state) => {
    if (state.tracks.length <= 1) return false; // always leave at least one track
    const before = state.tracks.length;
    state.tracks = state.tracks.filter((track) => track.id !== trackId);
    if (state.activeTrackId === trackId) state.activeTrackId = state.tracks[0]!.id;
    return state.tracks.length !== before;
  });
}

export function setSelection(documentId: string, trackId: string | null, clipIds: readonly string[]): void {
  kernel.documents.update<VideoDocumentState>(documentId, (state) => {
    state.selection = trackId && clipIds.length ? { trackId, clipIds } : null;
  });
}

/**
 * Places an imported video (or video's-own-audio) asset as a new clip at `startFrame` on
 * `trackId` (a new track of `trackKind` if none is given) — the import path's document-side
 * half. Probing the file's own duration/dimensions/frame rate happens upstream of this call
 * (`videoImport.ts`, via `HTMLVideoElement`, the only place in this feature that needs the DOM —
 * `@vravio/env-video` itself stays DOM-free, see its `environment.ts` doc comment).
 */
export async function addClipFromAsset(documentId: string, assetId: string, name: string, durationFrames: number, sourceFrameRate: number, trackKind: "video" | "audio", trackId?: string, startFrame = 0, sourceWidth = 0, sourceHeight = 0): Promise<void> {
  await changeVideoDocument(documentId, "Import Video (Импортировать видео)", (state) => {
    const track = trackId ? state.tracks.find((item) => item.id === trackId) : createVideoTrack(trackKind, name);
    if (!track) return false;
    if (!trackId) state.tracks.push(track);
    track.clips.push(createVideoClip(assetId, durationFrames, durationFrames, sourceFrameRate, { name, startFrame, sourceWidth, sourceHeight }));
    return true;
  });
  kernel.documents.addAssetRef(documentId, assetId as AssetId);
}
