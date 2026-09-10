import {
  applyCropEdge, applyLeftTrim, applyRightTrim, canSplitAt, cloneVideoState, constrainBoundaryTrim, constrainClipDrag,
  createVideoBinItem, createVideoClip, createVideoClipEffect, createVideoKeyframe, createVideoMarker, createVideoTitleClip, createVideoTrack,
  createVideoTransition, effectiveClipValue, rippleShift, splitClip, type VideoDocumentState, type VideoEffectId, type VideoKeyframeableParam,
  type VideoTitleContent, type VideoTransitionCurve,
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

/**
 * Adds a title clip at `atFrame` — a new video track if `trackId` is omitted, the same
 * new-track-when-unspecified convention `insertBinItemToTimeline` already uses. Titles never
 * collision-check against existing clips on the target track (matching that same precedent) —
 * the caller picks a sensible frame, usually the playhead on an empty or selected track.
 */
export function addTitleClip(documentId: string, trackId: string | undefined, atFrame: number, text: string, durationFrames: number): void {
  void changeVideoDocument(documentId, "Add Title (Добавить титр)", (state) => {
    const track = trackId ? state.tracks.find((item) => item.id === trackId) : createVideoTrack("video", "Titles (Титры)");
    if (!track) return false;
    if (!trackId) state.tracks.push(track);
    track.clips.push(createVideoTitleClip(text, durationFrames, { startFrame: atFrame }));
    return true;
  });
}

export function setTitleText(documentId: string, trackId: string, clipId: string, text: string): void {
  void changeVideoDocument(documentId, "Edit Title Text (Изменить текст титра)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip?.title || clip.title.text === text) return false;
    clip.title.text = text;
    return true;
  });
}

export function setTitleStyle(documentId: string, trackId: string, clipId: string, patch: Partial<Pick<VideoTitleContent, "fontFamily" | "fontSize" | "color" | "align">>): void {
  void changeVideoDocument(documentId, "Style Title (Стиль титра)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip?.title) return false;
    Object.assign(clip.title, patch);
    return true;
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

/**
 * Adds an imported asset to the Project bin without placing it on the timeline — the "import"
 * half of the donor import-then-place split (docs/master-plan.md §33.3's Монтаж layout: a
 * Project/Bin panel distinct from the timeline). `addClipFromAsset` remains the timeline-side
 * half, now called from `insertBinItemToTimeline` below instead of directly from file import.
 */
export function importToBin(documentId: string, assetId: string, name: string, kind: "video" | "audio", sourceDurationFrames: number, sourceFrameRate: number, sourceWidth = 0, sourceHeight = 0): void {
  void changeVideoDocument(documentId, "Import to Bin (Импорт в корзину)", (state) => {
    state.bin.push(createVideoBinItem(assetId, name, kind, sourceDurationFrames, sourceFrameRate, { sourceWidth, sourceHeight }));
    return true;
  });
  kernel.documents.addAssetRef(documentId, assetId as AssetId);
}

export function removeBinItem(documentId: string, binItemId: string): void {
  void changeVideoDocument(documentId, "Remove from Bin (Убрать из корзины)", (state) => {
    const before = state.bin.length;
    state.bin = state.bin.filter((item) => item.id !== binItemId);
    return state.bin.length !== before;
  });
}

/**
 * Creates a timeline clip from a bin item's marked `[inFrame, outFrame)` range (the Source
 * monitor's own in/out, in the *source's* own frame rate) at `atFrame` on `trackId` — the
 * "insert" half of the bin's own workflow. Falls back to the item's own kind when placing onto a
 * brand-new track (no `trackId` given).
 */
export function insertBinItemToTimeline(documentId: string, binItemId: string, trackId: string | undefined, atFrame: number, inFrame: number, outFrame: number): void {
  const document = kernel.documents.get<VideoDocumentState>(documentId);
  if (!document) return;
  const item = document.state.bin.find((entry) => entry.id === binItemId);
  if (!item) return;
  const durationFrames = Math.max(1, Math.round(outFrame) - Math.round(inFrame));
  void changeVideoDocument(documentId, "Insert Clip (Вставить клип)", (state) => {
    const track = trackId ? state.tracks.find((entry) => entry.id === trackId) : createVideoTrack(item.kind, item.name);
    if (!track) return false;
    if (!trackId) state.tracks.push(track);
    track.clips.push(createVideoClip(item.assetId, durationFrames, item.sourceDurationFrames, item.sourceFrameRate, {
      name: item.name, startFrame: Math.max(0, Math.round(atFrame)), offsetFrames: Math.max(0, Math.round(inFrame)),
      sourceWidth: item.sourceWidth, sourceHeight: item.sourceHeight,
    }));
    return true;
  });
  kernel.documents.addAssetRef(documentId, item.assetId as AssetId);
}

/** Position/scale/opacity — the OpenCut Classic checklist's `transform` item
 * (docs/master-plan.md §9.1). `patch` is applied over the clip's current values, so a caller
 * changing just one field (a single slider) doesn't need to read the others first. */
/** Resets x/y/scale/opacity to their defaults and clears every keyframe on those four
 * parameters — resetting only the flat fields while keyframes stayed would look like nothing
 * happened, since a keyframed parameter's effective value ignores its own flat field entirely. */
export function resetClipTransform(documentId: string, trackId: string, clipId: string): void {
  void changeVideoDocument(documentId, "Reset Transform (Сбросить трансформацию)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip) return false;
    clip.x = 0; clip.y = 0; clip.scale = 1; clip.opacity = 1;
    clip.keyframes = {};
    return true;
  });
}

export function setClipCrop(documentId: string, trackId: string, clipId: string, edge: "left" | "top" | "right" | "bottom", value: number): void {
  void changeVideoDocument(documentId, "Crop Clip (Обрезать кадр)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const clipIndex = track?.clips.findIndex((item) => item.id === clipId) ?? -1;
    if (!track || clipIndex === -1) return false;
    track.clips[clipIndex] = applyCropEdge(track.clips[clipIndex]!, edge, value);
    return true;
  });
}

// --- Effect stack (non-destructive, docs/master-plan.md §33.3's "Эффекты" panel) -----------

export function addClipEffect(documentId: string, trackId: string, clipId: string, effectId: VideoEffectId): void {
  void changeVideoDocument(documentId, "Add Effect (Добавить эффект)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip) return false;
    clip.effects.push(createVideoClipEffect(effectId));
    return true;
  });
}

export function removeClipEffect(documentId: string, trackId: string, clipId: string, effectInstanceId: string): void {
  void changeVideoDocument(documentId, "Remove Effect (Убрать эффект)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip) return false;
    const before = clip.effects.length;
    clip.effects = clip.effects.filter((effect) => effect.id !== effectInstanceId);
    return clip.effects.length !== before;
  });
}

export function setClipEffectEnabled(documentId: string, trackId: string, clipId: string, effectInstanceId: string, enabled: boolean): void {
  void changeVideoDocument(documentId, enabled ? "Enable Effect (Включить эффект)" : "Bypass Effect (Обойти эффект)", (state) => {
    const effect = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId)?.effects.find((item) => item.id === effectInstanceId);
    if (!effect) return false;
    effect.enabled = enabled;
    return true;
  });
}

/** Live-drag preview for a slider inside one effect's params — writes straight to the document
 * on every input event; the caller commits one history step at drag-end via
 * `commitVideoDrag`/`changeVideoDocument`'s own pattern (see `AudioWorkspace.tsx`'s equivalent
 * live-fader handling for the same reason: one undo step per drag, not one per pixel moved). */
export function previewClipEffectParam(documentId: string, trackId: string, clipId: string, effectInstanceId: string, paramId: string, value: number): void {
  kernel.documents.update<VideoDocumentState>(documentId, (state) => {
    const effect = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId)?.effects.find((item) => item.id === effectInstanceId);
    if (effect) effect.params[paramId] = value;
  });
}

export function reorderClipEffect(documentId: string, trackId: string, clipId: string, effectInstanceId: string, direction: "up" | "down"): void {
  void changeVideoDocument(documentId, "Reorder Effects (Изменить порядок эффектов)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip) return false;
    const index = clip.effects.findIndex((effect) => effect.id === effectInstanceId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index === -1 || target < 0 || target >= clip.effects.length) return false;
    const list = clip.effects;
    [list[index], list[target]] = [list[target]!, list[index]!];
    return true;
  });
}

// --- Keyframes (x/y/scale/opacity, docs/master-plan.md §33.3's `keyframes` timeline item) ---

/** Adds or updates a keyframe for `param` at `frameOnTimeline` to `value` — a caller passing the
 * parameter's own *current effective value* at that frame (rather than some other number)
 * matches every donor NLE's "toggle the stopwatch" behavior: turning on keyframing for a static
 * value first pins down what it already was, so nothing visibly jumps the instant it's turned
 * on. Snaps onto an existing keyframe within one frame rather than creating a near-duplicate. */
export function setClipKeyframe(documentId: string, trackId: string, clipId: string, param: VideoKeyframeableParam, frameOnTimeline: number, value: number): void {
  void changeVideoDocument(documentId, "Set Keyframe (Задать ключевой кадр)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip) return false;
    const list = clip.keyframes[param] ?? (clip.keyframes[param] = []);
    const existing = list.find((kf) => Math.abs(kf.frameOnTimeline - frameOnTimeline) < 1);
    if (existing) { existing.value = value; } else { list.push(createVideoKeyframe(frameOnTimeline, value)); }
    list.sort((a, b) => a.frameOnTimeline - b.frameOnTimeline);
    return true;
  });
}

export function removeClipKeyframe(documentId: string, trackId: string, clipId: string, param: VideoKeyframeableParam, keyframeId: string): void {
  void changeVideoDocument(documentId, "Delete Keyframe (Удалить ключевой кадр)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    const list = clip?.keyframes[param];
    if (!clip || !list) return false;
    const before = list.length;
    clip.keyframes[param] = list.filter((kf) => kf.id !== keyframeId);
    return clip.keyframes[param]!.length !== before;
  });
}

/** Clears every keyframe for `param`, reverting the clip to its flat static value — the "turn
 * off the stopwatch" action. The flat field itself is left at whatever it last was (usually the
 * value the playhead was sitting on), not reset to a default. */
export function clearClipKeyframes(documentId: string, trackId: string, clipId: string, param: VideoKeyframeableParam): void {
  void changeVideoDocument(documentId, "Clear Keyframes (Очистить ключевые кадры)", (state) => {
    const clip = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!clip || !clip.keyframes[param]?.length) return false;
    delete clip.keyframes[param];
    return true;
  });
}

/**
 * Sets `param` at the playhead: writes a new/updated keyframe there if the parameter is already
 * keyframed, otherwise just sets the flat field — the single entry point `VideoWorkspace.tsx`'s
 * Inspector sliders call regardless of whether keyframing is on for that field, so the caller
 * never has to branch on it itself.
 */
export function setClipParamAtPlayhead(documentId: string, trackId: string, clipId: string, param: VideoKeyframeableParam, frameOnTimeline: number, value: number): void {
  const document = kernel.documents.get<VideoDocumentState>(documentId);
  const clip = document?.state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
  if (!clip) return;
  if (clip.keyframes[param]?.length) { setClipKeyframe(documentId, trackId, clipId, param, frameOnTimeline, value); return; }
  void changeVideoDocument(documentId, "Transform Clip (Трансформировать клип)", (state) => {
    const target = state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
    if (!target) return false;
    target[param] = param === "scale" ? Math.max(0.05, value) : param === "opacity" ? Math.max(0, Math.min(1, value)) : value;
    return true;
  });
}

/** Toggles keyframing for `param` at the playhead: if a keyframe already sits there (within one
 * frame), removes it; otherwise adds one carrying the parameter's current effective value at
 * that frame — the "stopwatch diamond" button's own click behavior. */
export function toggleClipKeyframeAtPlayhead(documentId: string, trackId: string, clipId: string, param: VideoKeyframeableParam, frameOnTimeline: number): void {
  const document = kernel.documents.get<VideoDocumentState>(documentId);
  const clip = document?.state.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId);
  if (!clip) return;
  const existing = clip.keyframes[param]?.find((kf) => Math.abs(kf.frameOnTimeline - frameOnTimeline) < 1);
  if (existing) { removeClipKeyframe(documentId, trackId, clipId, param, existing.id); return; }
  setClipKeyframe(documentId, trackId, clipId, param, frameOnTimeline, effectiveClipValue(clip, param, frameOnTimeline));
}

// --- Transitions (crossfade between two adjacent clips, docs/master-plan.md §33.3's own
// "Переход — это объект между клипами... а не фильтр") -------------------------------------

/**
 * Creates a crossfade between `leftClipId` and `rightClipId` on `trackId`. The two clips must be
 * exactly adjacent (the right clip's `startFrame` equal to the left clip's own end) — a
 * transition is not a drag target, it connects a specific existing cut point. Overlaps the right
 * clip (and every later clip on the track, so nothing else on the timeline moves) leftward by
 * `durationFrames`, clamped to at most either clip's own length: `rippleShift` from
 * `clip-operations.ts` already shifts "this clip and everything after it," so calling it with
 * `fromFrame` set to the right clip's own (pre-shift) start does exactly the overlap this needs
 * in one pass, the same helper ripple-delete/ripple-trim already use for the opposite direction.
 */
export function addTransition(documentId: string, trackId: string, leftClipId: string, rightClipId: string, durationFrames: number, curve: VideoTransitionCurve = "linear"): void {
  void changeVideoDocument(documentId, "Add Transition (Добавить переход)", (state) => {
    const track = state.tracks.find((item) => item.id === trackId);
    const left = track?.clips.find((item) => item.id === leftClipId);
    const right = track?.clips.find((item) => item.id === rightClipId);
    if (!track || !left || !right) return false;
    if (right.startFrame !== left.startFrame + left.durationFrames) return false; // not adjacent
    const clamped = Math.max(1, Math.min(durationFrames, left.durationFrames, right.durationFrames));
    track.clips = rippleShift(track.clips, right.startFrame, -clamped);
    state.transitions.push(createVideoTransition(trackId, leftClipId, rightClipId, clamped, curve));
    return true;
  });
}

/** Removes a transition's own record without restoring the overlap it created — the clips stay
 * where the transition left them, the same "the edit already happened" choice a hard delete of
 * the transition object makes in every donor NLE; undo is what reverses the overlap, not this. */
export function removeTransition(documentId: string, transitionId: string): void {
  void changeVideoDocument(documentId, "Remove Transition (Убрать переход)", (state) => {
    const before = state.transitions.length;
    state.transitions = state.transitions.filter((item) => item.id !== transitionId);
    return state.transitions.length !== before;
  });
}

export function setTransitionCurve(documentId: string, transitionId: string, curve: VideoTransitionCurve): void {
  void changeVideoDocument(documentId, "Transition Curve (Кривая перехода)", (state) => {
    const transition = state.transitions.find((item) => item.id === transitionId);
    if (!transition || transition.curve === curve) return false;
    transition.curve = curve;
    return true;
  });
}

export function addVideoMarker(documentId: string, frameAt: number, name?: string): void {
  void changeVideoDocument(documentId, "Add Marker (Добавить маркер)", (state) => {
    const marker = createVideoMarker(name ?? `Marker ${state.markers.length + 1} (Маркер ${state.markers.length + 1})`, frameAt);
    state.markers.push(marker);
    state.markers.sort((a, b) => a.frameAt - b.frameAt);
    return true;
  });
}

export function renameVideoMarker(documentId: string, markerId: string, name: string): void {
  void changeVideoDocument(documentId, "Rename Marker (Переименовать маркер)", (state) => {
    const marker = state.markers.find((item) => item.id === markerId);
    if (!marker || marker.name === name) return false;
    marker.name = name;
    return true;
  });
}

export function removeVideoMarker(documentId: string, markerId: string): void {
  void changeVideoDocument(documentId, "Delete Marker (Удалить маркер)", (state) => {
    const before = state.markers.length;
    state.markers = state.markers.filter((item) => item.id !== markerId);
    return state.markers.length !== before;
  });
}

export function moveVideoMarker(documentId: string, markerId: string, frameAt: number): void {
  const document = kernel.documents.get<VideoDocumentState>(documentId);
  if (!document) return;
  const marker = document.state.markers.find((item) => item.id === markerId);
  if (!marker) return;
  kernel.documents.update<VideoDocumentState>(documentId, (current) => {
    const found = current.markers.find((item) => item.id === markerId);
    if (found) found.frameAt = Math.max(0, Math.round(frameAt));
  });
}
