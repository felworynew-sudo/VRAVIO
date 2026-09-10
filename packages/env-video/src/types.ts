/**
 * Positions and lengths are in frames at the document's own `frameRate`, not seconds — the same
 * reasoning `@vravio/env-audio`'s own `AudioClip` gives for samples (docs/master-plan.md §9.2):
 * frame counts are exact integers, seconds accumulate floating-point drift over a long edit
 * session and make "does this clip start exactly where the last one ended" an epsilon comparison
 * instead of `===`. A video document's own timeline is frame-addressed for the same reason a
 * video editor's playhead snaps to frame boundaries in the first place — there is no such thing
 * as "half a frame" once the material is rendered.
 */

export interface VideoClip {
  readonly id: string;
  name: string;
  /** Reference into the shared asset store — a clip never carries its own decoded video here,
   * the same "asset, not a copy" rule raster layers and audio clips follow. */
  assetId: string;
  /** Position on the timeline, in frames at the document's frame rate. */
  startFrame: number;
  /** Length on the timeline, in frames at the document's frame rate. */
  durationFrames: number;
  /** Trim-in: how far into the source this clip's visible/audible region begins, in frames at
   * the *source's own* frame rate (see `sourceFrameRate`). */
  offsetFrames: number;
  /** Full length of the source, in frames at the source's own frame rate — the right-edge trim
   * bound (a clip cannot extend past what its source actually contains). */
  sourceDurationFrames: number;
  /** The source's native frame rate. Equal to the document's frame rate for footage imported at
   * the project rate; different when a source needs retiming to play in sync (23.976 fps footage
   * cut into a 30 fps timeline, for instance). */
  sourceFrameRate: number;
  /** The source's native pixel dimensions — needed by `compositor-math.ts`'s crop/fit
   * calculation at render time without an async re-probe of the asset on every frame. Absent
   * (both 0) for a clip on an `"audio"` track, which is never composited. */
  sourceWidth: number;
  sourceHeight: number;
  /** Linear gain multiplier for this clip's own embedded audio (if any), 1 = unity (0 dB). Has
   * no effect on a clip sitting on an `"audio"` track — that track's `volume` is what applies
   * there, the same split raster keeps between a layer's own opacity and a group's. */
  gain: number;
  /** Pixel offset from this clip's default centered "fit inside the document" position — the
   * OpenCut Classic checklist's own `position` (docs/master-plan.md §9.1). 0,0 is centered. */
  x: number;
  y: number;
  /** Uniform multiplier on the default fit size, applied around the fitted rect's own center —
   * 1 = the clip's cropped source fits the document exactly (`object-fit: contain`). */
  scale: number;
  /** 0 (invisible) .. 1 (opaque) — this clip's own contribution when composited over whatever
   * is on the video tracks below it. */
  opacity: number;
  /** Fraction of the *source* frame cropped away from each edge, 0..1, cropLeft+cropRight < 1
   * and cropTop+cropBottom < 1 enforced by `clip-operations.ts`'s `constrainCrop`. Applied
   * before the fit-to-document calculation, so a crop changes what part of the source shows,
   * not just how much of the document it covers. */
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
}

export interface VideoTrack {
  readonly id: string;
  name: string;
  /** A `"video"` track composites its clips' frames — every visible (`!hidden`) video track's
   * current clip is alpha-blended in track order (later entries in `VideoDocumentState.tracks`
   * draw on top, the same bottom-to-top convention raster layers use), not "topmost wins"; an
   * `"audio"` track only ever contributes sound, the same distinction Premiere/Resolve draw
   * between V and A tracks. */
  kind: "video" | "audio";
  /** Linear volume multiplier, 1 = unity (0 dB) — this track's own contribution to the mix,
   * independent of any embedded-clip `gain`. */
  volume: number;
  muted: boolean;
  /** Visual visibility — meaningless for an `"audio"` track (kept on every track for a single
   * uniform shape, the same reason `AudioTrack.pan` exists even though nothing reads it for a
   * track that never has stereo content of its own). */
  hidden: boolean;
  locked: boolean;
  clips: VideoClip[];
}

export interface VideoSelection {
  readonly trackId: string;
  readonly clipIds: readonly string[];
}

/** A named point on the timeline — the same role Kdenlive/Premiere's own "marker" plays: a scene
 * cut reference, a sync point, a note to come back to. `frameAt` in the document's own frame
 * rate, same unit every other timeline position in this file uses. */
export interface VideoMarker {
  readonly id: string;
  name: string;
  frameAt: number;
}

export interface VideoDocumentState {
  kind: "video";
  schemaVersion: 1;
  frameRate: number;
  /** Frame size in pixels — the canvas every video track composites onto. */
  width: number;
  height: number;
  tracks: VideoTrack[];
  activeTrackId: string;
  selection: VideoSelection | null;
  markers: VideoMarker[];
}

export interface VideoDocumentOptions {
  frameRate?: number;
  width?: number;
  height?: number;
}
