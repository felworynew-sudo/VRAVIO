import type {
  AssetId, AssetRecord, AssetStore, DocumentStore, Environment, ExportOptions, ExtractOptions, ExtractedAsset, ParentTarget, VravioDocument,
} from "@vravio/kernel";
import { createVideoClip, createVideoDocument, createVideoTrack } from "./document";
import type { VideoDocumentOptions, VideoDocumentState } from "./types";

export interface VideoEnvironmentOptions {
  readonly documents: DocumentStore;
  readonly assets: AssetStore;
}

export interface CreateVideoOptions extends VideoDocumentOptions {
  readonly name?: string;
}

/**
 * Metadata a video asset must carry in `AssetRecord.meta` before this environment can build a
 * clip from it. Video containers (mp4/webm/mov) are not a format this package can parse itself
 * the way `@vravio/env-audio`'s `wav.ts` parses WAV — a full demuxer is out of scope for a pure,
 * DOM-free engine package (docs/migration-plan.md §2's layering: browser APIs live in apps/web).
 * So the probe happens once, in apps/web, at import time (`HTMLVideoElement`'s own
 * `loadedmetadata`, the same technique `MediaWorkspace.tsx` already used before this environment
 * existed), and its result is carried on the asset record from then on — the same reason a
 * raster layer's `pixelAssetId` carries dimensions in its own header (`raster-asset.ts`) rather
 * than asking the engine to re-decode PNG/JPEG.
 */
export interface VideoAssetMeta {
  readonly durationFrames: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

export function isVideoAssetMeta(value: unknown): value is VideoAssetMeta {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VideoAssetMeta>;
  return typeof candidate.durationFrames === "number" && candidate.durationFrames > 0
    && typeof candidate.width === "number" && candidate.width > 0
    && typeof candidate.height === "number" && candidate.height > 0
    && typeof candidate.frameRate === "number" && candidate.frameRate > 0;
}

function requireVideoMeta(record: AssetRecord): VideoAssetMeta {
  if (!isVideoAssetMeta(record.meta)) {
    throw new Error(`Asset ${record.id} ("${record.name}") has no probed video metadata (durationFrames/width/height/frameRate) — it must be imported with that metadata already attached, since this environment cannot decode the video container itself.`);
  }
  return record.meta;
}

const defaultName = "Video project (Видеопроект)";

/**
 * The video editor, as the kernel sees it — mirrors `AudioEnvironment`'s shape (itself written
 * against `RasterEnvironment`'s template). A clip moves across the environment boundary the same
 * way an audio clip or a raster layer does: by asset reference, never by copying decoded frames
 * through document state.
 *
 * Scope for this pass (docs/master-plan.md §9.1's v0.1 checklist — timeline editing, not yet
 * compositing/export): `extractAsset` and `exportAsAsset` require actually re-encoding a video
 * container (trimming, concatenating, compositing overlapping tracks), which needs a real decode/
 * encode pipeline this pass does not build — they throw a clear, named error rather than return
 * silently wrong media, the same choice `plugins/host.ts` makes for a refusal: failing loudly
 * before doing the wrong thing is better than a checkbox that does nothing (CLAUDE.md §3).
 */
export class VideoEnvironment implements Environment<VideoDocumentState> {
  readonly kind = "video" as const;
  readonly #documents: DocumentStore;
  readonly #assets: AssetStore;

  constructor(options: VideoEnvironmentOptions) {
    this.#documents = options.documents;
    this.#assets = options.assets;
  }

  whenSettled(): Promise<void> { return Promise.resolve(); }

  async createEmpty(options: CreateVideoOptions = {}): Promise<VravioDocument<VideoDocumentState>> {
    const state = createVideoDocument(options);
    return this.#documents.create("video", options.name?.trim() || defaultName, state);
  }

  async createFromAsset(assetId: AssetId, options: { title?: string } = {}): Promise<VravioDocument<VideoDocumentState>> {
    const record = this.#assets.mustGet(assetId);
    const meta = requireVideoMeta(record);

    const state = createVideoDocument({ frameRate: meta.frameRate, width: meta.width, height: meta.height });
    const track = state.tracks[0]!;
    const clip = createVideoClip(assetId, meta.durationFrames, meta.durationFrames, meta.frameRate, { name: options.title ?? record.name });
    track.clips.push(clip);

    const document = this.#documents.create("video", options.title ?? record.name, state, {
      origin: { kind: "asset", assetId, rev: record.head, name: record.name },
      assetRefs: [assetId],
    });
    return document;
  }

  async extractAsset(_document: VravioDocument<VideoDocumentState>, target: ParentTarget, _options: ExtractOptions): Promise<ExtractedAsset> {
    if (target.kind !== "video-clip" && target.kind !== "video-clip-audio") throw new Error(`A video document has no ${target.kind}`);
    throw new Error("Extracting a trimmed clip out of a video document requires a decode/re-encode pipeline not yet built (docs/master-plan.md §9.1) — not implemented.");
  }

  async exportAsAsset(_document: VravioDocument<VideoDocumentState>, options: ExportOptions): Promise<Uint8Array> {
    if (options.kind !== "video") throw new Error(`A video document cannot be exported as ${options.kind}`);
    throw new Error("Rendering a video timeline to a delivery file requires a compositing/encode pipeline not yet built (docs/master-plan.md §9.1) — not implemented.");
  }

  /**
   * A no-op for video, unlike `AudioEnvironment`'s own `onAssetRevised`: WAV bytes are
   * self-describing (sample rate and length live in the file itself), so audio can decode a new
   * revision and clamp clips against it directly. A video container's duration cannot be read
   * without a DOM `HTMLVideoElement`, and `AssetStore.commitRevision` does not update
   * `AssetRecord.meta` — there is no probed metadata for a revision to read here at all. Committing
   * a new revision of a video asset is therefore the caller's job in apps/web: re-probe the
   * replacement file's metadata (the same technique `createFromAsset` requires at import) and
   * clamp affected clips directly through `kernel.documents.update`, the way `video-commands.ts`
   * already has to for every other structural edit.
   */
  onAssetRevised(_document: VravioDocument<VideoDocumentState>, _assetId: AssetId, _rev: number, _note?: string): void {}

  async relinkTarget(document: VravioDocument<VideoDocumentState>, target: ParentTarget, newAssetId: AssetId): Promise<void> {
    if (target.kind !== "video-clip" && target.kind !== "video-clip-audio") throw new Error(`A video document has no ${target.kind}`);
    const record = this.#assets.mustGet(newAssetId);
    const meta = requireVideoMeta(record);

    this.#documents.update<VideoDocumentState>(document.id, (state) => {
      const clip = state.tracks.find((item) => item.id === target.trackId)?.clips.find((item) => item.id === target.clipId);
      if (!clip) throw new Error(`Unknown clip: ${target.trackId}/${target.clipId}`);
      clip.assetId = newAssetId;
      clip.sourceFrameRate = meta.frameRate;
      clip.sourceDurationFrames = meta.durationFrames;
      clip.offsetFrames = Math.min(clip.offsetFrames, meta.durationFrames);
      clip.durationFrames = Math.min(clip.durationFrames, meta.durationFrames - clip.offsetFrames);
    });
    this.#documents.addAssetRef(document.id, newAssetId);
  }

  describeChanges(document: VravioDocument<VideoDocumentState>): string {
    const clipCount = document.state.tracks.reduce((sum, track) => sum + track.clips.length, 0);
    const trackCount = document.state.tracks.length;
    return `Video edit (${clipCount} clip${clipCount === 1 ? "" : "s"} on ${trackCount} track${trackCount === 1 ? "" : "s"})`;
  }

  /** Adds a track from an imported video/audio asset without opening a document for it — the
   * video-side counterpart to `AudioEnvironment.appendAssetAsTrack`. */
  async appendAssetAsTrack(document: VravioDocument<VideoDocumentState>, assetId: AssetId, trackKind: "video" | "audio", name?: string): Promise<void> {
    const record = this.#assets.mustGet(assetId);
    const meta = requireVideoMeta(record);
    const track = createVideoTrack(trackKind, name ?? record.name);
    track.clips.push(createVideoClip(assetId, meta.durationFrames, meta.durationFrames, meta.frameRate, { name: track.name }));
    this.#documents.update<VideoDocumentState>(document.id, (state) => { state.tracks.push(track); });
    this.#documents.addAssetRef(document.id, assetId);
  }
}
