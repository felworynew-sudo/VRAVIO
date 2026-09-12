import type {
  VideoBinItem, VideoClip, VideoClipEffect, VideoDocumentOptions, VideoDocumentState, VideoKeyframe, VideoKeyframeableParam, VideoMarker,
  VideoTitleContent, VideoTrack, VideoTransition, VideoTransitionCurve,
} from "./types";
import { videoEffectDefaults, type VideoEffectId } from "./effects";

export function createVideoTrack(kind: "video" | "audio", name?: string): VideoTrack {
  return {
    id: crypto.randomUUID(),
    name: name ?? (kind === "video" ? "Video 1 (Видео 1)" : "Audio 1 (Аудио 1)"),
    kind, volume: 1, muted: false, solo: false, hidden: false, locked: false, clips: [],
  };
}

export interface CreateVideoClipOptions {
  readonly name?: string;
  readonly startFrame?: number;
  readonly offsetFrames?: number;
  readonly gain?: number;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
}

export function createVideoClip(assetId: string, durationFrames: number, sourceDurationFrames: number, sourceFrameRate: number, options: CreateVideoClipOptions = {}): VideoClip {
  return {
    id: crypto.randomUUID(),
    name: options.name ?? "Clip (Клип)",
    assetId,
    startFrame: Math.max(0, Math.floor(options.startFrame ?? 0)),
    durationFrames: Math.max(0, Math.floor(durationFrames)),
    offsetFrames: Math.max(0, Math.floor(options.offsetFrames ?? 0)),
    sourceDurationFrames: Math.max(0, Math.floor(sourceDurationFrames)),
    sourceFrameRate,
    sourceWidth: Math.max(0, Math.floor(options.sourceWidth ?? 0)),
    sourceHeight: Math.max(0, Math.floor(options.sourceHeight ?? 0)),
    gain: options.gain ?? 1,
    x: 0, y: 0, scale: 1, opacity: 1,
    cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0,
    effects: [], keyframes: {},
  };
}

export interface CreateVideoTitleClipOptions {
  readonly startFrame?: number;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly color?: string;
  readonly align?: VideoTitleContent["align"];
}

/** A title clip — no `assetId`, its own text rendered directly (`VideoClip.title`'s own doc
 * comment on why this isn't the raster text engine). `durationFrames` is otherwise a normal
 * timeline length; `sourceDurationFrames`/`sourceFrameRate` are set equal to it so trim math that
 * reads them (crop, split, ripple) still has sane bounds even though there is no real source to
 * trim into. */
export function createVideoTitleClip(text: string, durationFrames: number, options: CreateVideoTitleClipOptions = {}): VideoClip {
  const clip = createVideoClip("", durationFrames, durationFrames, 30, { name: "Title (Титр)", startFrame: options.startFrame ?? 0 });
  clip.title = {
    text, fontFamily: options.fontFamily ?? "sans-serif", fontSize: options.fontSize ?? 64,
    color: options.color ?? "#ffffff", align: options.align ?? "center",
  };
  return clip;
}

export function createVideoClipEffect(effectId: VideoEffectId): VideoClipEffect {
  return { id: crypto.randomUUID(), effectId, params: videoEffectDefaults(effectId), enabled: true };
}

export function createVideoKeyframe(frameOnTimeline: number, value: number): VideoKeyframe {
  return { id: crypto.randomUUID(), frameOnTimeline: Math.max(0, Math.round(frameOnTimeline)), value };
}

/** Linear interpolation between the two keyframes surrounding `frame`; holds the nearest
 * keyframe's value before the first or after the last, same convention audio automation lanes
 * use. Falls back to `staticValue` when the parameter has no keyframes at all — the "not
 * animated" case is not a one-keyframe special case, it is simply absent. */
export function evaluateKeyframedValue(keyframes: readonly VideoKeyframe[] | undefined, frame: number, staticValue: number): number {
  if (!keyframes || keyframes.length === 0) return staticValue;
  const sorted = [...keyframes].sort((a, b) => a.frameOnTimeline - b.frameOnTimeline);
  if (frame <= sorted[0]!.frameOnTimeline) return sorted[0]!.value;
  const last = sorted[sorted.length - 1]!;
  if (frame >= last.frameOnTimeline) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted[i]!, right = sorted[i + 1]!;
    if (frame >= left.frameOnTimeline && frame <= right.frameOnTimeline) {
      if (right.frameOnTimeline === left.frameOnTimeline) return right.value;
      const t = (frame - left.frameOnTimeline) / (right.frameOnTimeline - left.frameOnTimeline);
      return left.value + (right.value - left.value) * t;
    }
  }
  return staticValue;
}

/** The clip's own effective value for a keyframeable parameter at an absolute timeline `frame` —
 * what the compositor actually renders with, and what the Inspector shows when scrubbing.
 * `param` selects both the keyframe list and the flat fallback field, so a caller never has to
 * duplicate that mapping. */
export function effectiveClipValue(clip: VideoClip, param: VideoKeyframeableParam, frame: number): number {
  return evaluateKeyframedValue(clip.keyframes[param], frame, clip[param]);
}

export function createVideoDocument(options: VideoDocumentOptions = {}): VideoDocumentState {
  const track = createVideoTrack("video");
  return {
    kind: "video", schemaVersion: 1,
    frameRate: options.frameRate ?? 30, width: options.width ?? 1920, height: options.height ?? 1080,
    tracks: [track], activeTrackId: track.id, selection: null, markers: [], bin: [], transitions: [],
  };
}

export function createVideoMarker(name: string, frameAt: number): VideoMarker {
  return { id: crypto.randomUUID(), name, frameAt: Math.max(0, Math.floor(frameAt)) };
}

export interface CreateVideoBinItemOptions {
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
}

export function createVideoBinItem(assetId: string, name: string, kind: "video" | "audio", sourceDurationFrames: number, sourceFrameRate: number, options: CreateVideoBinItemOptions = {}): VideoBinItem {
  return {
    id: crypto.randomUUID(), name, assetId, kind,
    sourceDurationFrames: Math.max(0, Math.floor(sourceDurationFrames)), sourceFrameRate,
    sourceWidth: Math.max(0, Math.floor(options.sourceWidth ?? 0)), sourceHeight: Math.max(0, Math.floor(options.sourceHeight ?? 0)),
  };
}

export function createVideoTransition(trackId: string, leftClipId: string, rightClipId: string, durationFrames: number, curve: VideoTransitionCurve = "linear"): VideoTransition {
  return { id: crypto.randomUUID(), trackId, leftClipId, rightClipId, durationFrames: Math.max(1, Math.floor(durationFrames)), curve };
}

export function isVideoDocumentState(value: unknown): value is VideoDocumentState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VideoDocumentState>;
  if (candidate.kind !== "video" || candidate.schemaVersion !== 1 || !Array.isArray(candidate.tracks) || typeof candidate.frameRate !== "number") return false;
  migrateVideoDocumentState(candidate as VideoDocumentState);
  return true;
}

/** In-place and idempotent, same convention as `migrateAudioDocumentState` — a session
 * persisted before a field existed restores with it added, rather than failing
 * `isVideoDocumentState` (and thus refusing to open) the moment a field is missing. */
export function migrateVideoDocumentState(state: VideoDocumentState): VideoDocumentState {
  if (!Array.isArray(state.markers)) state.markers = [];
  if (!Array.isArray(state.bin)) state.bin = [];
  if (!Array.isArray(state.transitions)) state.transitions = [];
  for (const track of state.tracks) {
    if (typeof track.hidden !== "boolean") track.hidden = false;
    if (typeof track.solo !== "boolean") track.solo = false;
    if (typeof track.volume !== "number") track.volume = 1;
    for (const clip of track.clips) {
      if (typeof clip.x !== "number") clip.x = 0;
      if (typeof clip.y !== "number") clip.y = 0;
      if (typeof clip.scale !== "number") clip.scale = 1;
      if (typeof clip.opacity !== "number") clip.opacity = 1;
      if (typeof clip.cropLeft !== "number") clip.cropLeft = 0;
      if (typeof clip.cropTop !== "number") clip.cropTop = 0;
      if (typeof clip.cropRight !== "number") clip.cropRight = 0;
      if (typeof clip.cropBottom !== "number") clip.cropBottom = 0;
      if (typeof clip.sourceWidth !== "number") clip.sourceWidth = 0;
      if (typeof clip.sourceHeight !== "number") clip.sourceHeight = 0;
      if (!Array.isArray(clip.effects)) clip.effects = [];
      if (!clip.keyframes || typeof clip.keyframes !== "object") clip.keyframes = {};
    }
  }
  return state;
}

/**
 * A document snapshot cheap enough to take on every structural edit — same shape as
 * `cloneAudioState`: shallow across what dominates memory (there is nothing large here; clips
 * carry no decoded frames, only an `assetId` reference), deep enough that mutating one
 * snapshot's clip array never bleeds into the other's.
 */
export function cloneVideoState(state: VideoDocumentState): VideoDocumentState {
  return {
    ...state,
    tracks: state.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({
      ...clip,
      effects: clip.effects.map((effect) => ({ ...effect, params: { ...effect.params } })),
      keyframes: Object.fromEntries(Object.entries(clip.keyframes).map(([param, list]) => [param, list!.map((kf) => ({ ...kf }))])),
      ...(clip.title ? { title: { ...clip.title } } : {}),
    })) })),
    selection: state.selection ? { trackId: state.selection.trackId, clipIds: [...state.selection.clipIds] } : null,
    markers: state.markers.map((marker) => ({ ...marker })),
    bin: state.bin.map((item) => ({ ...item })),
    transitions: state.transitions.map((transition) => ({ ...transition })),
  };
}

export function findTrack(state: VideoDocumentState, trackId: string): VideoTrack | undefined {
  return state.tracks.find((track) => track.id === trackId);
}

export function findClip(state: VideoDocumentState, trackId: string, clipId: string): VideoClip | undefined {
  return findTrack(state, trackId)?.clips.find((clip) => clip.id === clipId);
}

/** End of the last clip across every track, in frames — the timeline's own length. */
export function timelineDurationFrames(state: VideoDocumentState): number {
  let end = 0;
  for (const track of state.tracks) for (const clip of track.clips) end = Math.max(end, clip.startFrame + clip.durationFrames);
  return end;
}
