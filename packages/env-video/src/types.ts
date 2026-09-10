import type { VideoEffectId } from "./effects";

/**
 * Positions and lengths are in frames at the document's own `frameRate`, not seconds — the same
 * reasoning `@vravio/env-audio`'s own `AudioClip` gives for samples (docs/master-plan.md §9.2):
 * frame counts are exact integers, seconds accumulate floating-point drift over a long edit
 * session and make "does this clip start exactly where the last one ended" an epsilon comparison
 * instead of `===`. A video document's own timeline is frame-addressed for the same reason a
 * video editor's playhead snaps to frame boundaries in the first place — there is no such thing
 * as "half a frame" once the material is rendered.
 */

/** One insert in a clip's non-destructive effect stack — the video-side counterpart to
 * `AudioTrackEffect`, applied in array order as CSS/Canvas2D `filter` fragments
 * (`effects.ts`'s `videoEffectCssFragment`) during compositing, never baked into the source. */
export interface VideoClipEffect {
  readonly id: string;
  readonly effectId: VideoEffectId;
  params: Record<string, number>;
  enabled: boolean;
}

/** One keyframe on a single animatable parameter — `frameOnTimeline` is an absolute timeline
 * position (not clip-relative), the same frame unit every other timeline position in this file
 * uses, so a keyframe still lines up correctly after a clip's `startFrame` moves without needing
 * to be re-expressed. Only the four transform parameters are keyframeable for this pass — enough
 * to animate a pan/zoom/fade, the OpenCut Classic checklist's own `keyframes` item
 * (docs/master-plan.md §9.1) — not an arbitrary-parameter system yet. */
export interface VideoKeyframe {
  readonly id: string;
  frameOnTimeline: number;
  value: number;
}

export type VideoKeyframeableParam = "x" | "y" | "scale" | "opacity";

/**
 * A title clip's own text content — a lightweight built-in renderer (`CanvasRenderingContext2D`
 * `fillText`, applied where `VideoClip.title` is set), not VRAVIO's raster text engine: that
 * engine lives inside `@vravio/env-raster`, and the kernel's own environment boundary
 * (docs/master-plan.md §35) keeps environments from depending on each other, so Video cannot
 * reach into Raster for it without breaking that boundary first. Honestly scoped as its own
 * simple renderer rather than claimed to be "the same text engine" docs/master-plan.md §33.3's
 * own prose describes — richer typography (multi-run formatting, paths, the raster engine's own
 * layout features) is a later, larger architectural decision (share text layout through the
 * kernel, or accept two renderers), not this pass's problem to solve.
 */
export interface VideoTitleContent {
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
}

export interface VideoClip {
  readonly id: string;
  name: string;
  /** Reference into the shared asset store — a clip never carries its own decoded video here,
   * the same "asset, not a copy" rule raster layers and audio clips follow. Empty for a title
   * clip (`title` set below) — a title has no source asset, it renders its own text directly. */
  assetId: string;
  /** Present only on a title clip — when set, the compositor renders this text instead of
   * decoding `assetId` (which is `""` for a title clip; every asset-decode/seek path skips a
   * clip with `title` set entirely, never attempting to resolve an asset that doesn't exist). */
  title?: VideoTitleContent;
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
  /** Non-destructive effect stack, applied in order — `effects.ts`'s catalog, the video-side
   * counterpart to a track's `AudioTrackEffect[]`. Empty for the overwhelming majority of clips
   * that have none, same as an audio track's own `effects` array usually is. */
  effects: VideoClipEffect[];
  /** Keyframes per animatable parameter, absolute timeline frames — absent (or an empty array)
   * for a parameter with no animation, in which case the flat `x`/`y`/`scale`/`opacity` field
   * above is what's used, the same "no keyframes yet" default every donor NLE starts a clip in. */
  keyframes: Partial<Record<VideoKeyframeableParam, VideoKeyframe[]>>;
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

/**
 * An imported asset the project knows about but that isn't necessarily placed on the timeline
 * yet — the donor "Project/Bin" panel's own row (docs/master-plan.md §33.3's Монтаж layout).
 * Importing a file adds it here; it only becomes a `VideoClip` once dragged or inserted onto a
 * track, the same import-then-place split every NLE donor makes and VRAVIO's own earlier
 * "import lands straight on the timeline" shortcut didn't.
 */
/** How the blend weight moves from 0 to 1 across a transition's own duration — the same small,
 * fixed taxonomy every donor NLE offers for a basic dissolve (a real curve editor is a follow-up,
 * not this pass). */
export type VideoTransitionCurve = "linear" | "easeIn" | "easeOut" | "easeInOut";

/**
 * A crossfade between two *adjacent* clips on the same track — an object with its own
 * duration/curve, not a filter hidden on one of the two clips (docs/master-plan.md §33.3: "Переход
 * — это объект между клипами... а не фильтр"). Adding one overlaps `rightClipId` (and everything
 * after it on the track) leftward by `durationFrames` — `video-commands.ts`'s `addTransition` is
 * the one door that creates this overlap and this record together, so a transition never exists
 * without the overlap it depends on, or vice versa.
 */
export interface VideoTransition {
  readonly id: string;
  readonly trackId: string;
  readonly leftClipId: string;
  readonly rightClipId: string;
  durationFrames: number;
  curve: VideoTransitionCurve;
}

export interface VideoBinItem {
  readonly id: string;
  name: string;
  assetId: string;
  kind: "video" | "audio";
  /** The source's own full length and frame rate — what a `VideoClip` created from this item
   * would inherit as `sourceDurationFrames`/`sourceFrameRate`, same units. */
  sourceDurationFrames: number;
  sourceFrameRate: number;
  sourceWidth: number;
  sourceHeight: number;
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
  bin: VideoBinItem[];
  transitions: VideoTransition[];
}

export interface VideoDocumentOptions {
  frameRate?: number;
  width?: number;
  height?: number;
}
