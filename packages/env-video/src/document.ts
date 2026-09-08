import type { VideoClip, VideoDocumentOptions, VideoDocumentState, VideoTrack } from "./types";

export function createVideoTrack(kind: "video" | "audio", name?: string): VideoTrack {
  return {
    id: crypto.randomUUID(),
    name: name ?? (kind === "video" ? "Video 1 (Видео 1)" : "Audio 1 (Аудио 1)"),
    kind, volume: 1, muted: false, hidden: false, locked: false, clips: [],
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
  };
}

export function createVideoDocument(options: VideoDocumentOptions = {}): VideoDocumentState {
  const track = createVideoTrack("video");
  return {
    kind: "video", schemaVersion: 1,
    frameRate: options.frameRate ?? 30, width: options.width ?? 1920, height: options.height ?? 1080,
    tracks: [track], activeTrackId: track.id, selection: null,
  };
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
  for (const track of state.tracks) {
    if (typeof track.hidden !== "boolean") track.hidden = false;
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
    tracks: state.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip })) })),
    selection: state.selection ? { trackId: state.selection.trackId, clipIds: [...state.selection.clipIds] } : null,
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
