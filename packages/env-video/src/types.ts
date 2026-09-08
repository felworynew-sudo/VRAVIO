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
  /** Linear gain multiplier for this clip's own embedded audio (if any), 1 = unity (0 dB). Has
   * no effect on a clip sitting on an `"audio"` track — that track's `volume` is what applies
   * there, the same split raster keeps between a layer's own opacity and a group's. */
  gain: number;
}

export interface VideoTrack {
  readonly id: string;
  name: string;
  /** A `"video"` track composites its clips' frames (topmost non-hidden video track wins,
   * matching `docs/master-plan.md`'s own compositing note — see `environment.ts`); an
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
}

export interface VideoDocumentOptions {
  frameRate?: number;
  width?: number;
  height?: number;
}
