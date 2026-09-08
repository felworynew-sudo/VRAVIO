import type {
  AssetId, AssetStore, DocumentStore, Environment, ExportOptions, ExtractOptions, ExtractedAsset, ParentTarget, VravioDocument,
} from "@vravio/kernel";
import { createAudioClip, createAudioDocument, createAudioTrack } from "./document";
import { mixdownAudioDocument } from "./mixdown";
import { decodeWav, encodeWav } from "./wav";
import type { AudioDocumentOptions, AudioDocumentState } from "./types";

export interface AudioEnvironmentOptions {
  readonly documents: DocumentStore;
  readonly assets: AssetStore;
}

export interface CreateAudioOptions extends AudioDocumentOptions {
  readonly name?: string;
}

const defaultName = "Audio session (Аудиосессия)";

/**
 * The audio editor, as the kernel sees it — mirrors `RasterEnvironment`'s shape exactly
 * (packages/env-raster/src/environment.ts is the template this was written against). A clip
 * moves across the environment boundary the same way a raster layer does: by asset reference,
 * never by copying decoded PCM through document state.
 */
export class AudioEnvironment implements Environment<AudioDocumentState> {
  readonly kind = "audio" as const;
  readonly #documents: DocumentStore;
  readonly #assets: AssetStore;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: AudioEnvironmentOptions) {
    this.#documents = options.documents;
    this.#assets = options.assets;
  }

  whenSettled(): Promise<void> { return this.#pending; }

  async createEmpty(options: CreateAudioOptions = {}): Promise<VravioDocument<AudioDocumentState>> {
    const state = createAudioDocument(options);
    return this.#documents.create("audio", options.name?.trim() || defaultName, state);
  }

  async createFromAsset(assetId: AssetId, options: { title?: string } = {}): Promise<VravioDocument<AudioDocumentState>> {
    const record = this.#assets.mustGet(assetId);
    const bytes = await this.#assets.read(assetId);
    if (!bytes) throw new Error(`Asset ${assetId} has no bytes at revision ${record.head}`);
    const decoded = decodeWav(bytes);
    const durationSamples = decoded.channelData[0]?.length ?? 0;

    const state = createAudioDocument({ sampleRate: decoded.sampleRate, channels: decoded.channelData.length >= 2 ? 2 : 1 });
    const track = state.tracks[0]!;
    const clip = createAudioClip(assetId, durationSamples, durationSamples, decoded.sampleRate, { name: options.title ?? record.name });
    track.clips.push(clip);

    const document = this.#documents.create("audio", options.title ?? record.name, state, {
      origin: { kind: "asset", assetId, rev: record.head, name: record.name },
      assetRefs: [assetId],
    });
    return document;
  }

  async extractAsset(document: VravioDocument<AudioDocumentState>, target: ParentTarget, options: ExtractOptions): Promise<ExtractedAsset> {
    if (target.kind !== "audio-clip") throw new Error(`An audio document has no ${target.kind}`);
    const track = document.state.tracks.find((item) => item.id === target.trackId);
    const clip = track?.clips.find((item) => item.id === target.clipId);
    if (!track || !clip) throw new Error(`Unknown clip: ${target.trackId}/${target.clipId}`);

    const bytes = await this.#assets.read(clip.assetId as AssetId);
    if (!bytes) throw new Error(`Asset ${clip.assetId} has no bytes`);
    const decoded = decodeWav(bytes);

    // A clip is a window into its source, so the extracted material is that window (plus
    // handles either side, clamped to what the source actually has) — never the whole source,
    // which would hand over audio the target range never included.
    const start = Math.max(0, clip.offsetSamples - options.handles);
    const end = Math.min(decoded.channelData[0]?.length ?? 0, clip.offsetSamples + clip.durationSamples + options.handles);
    const sliced = decoded.channelData.map((channel) => channel.slice(start, end));
    const handleOffset = clip.offsetSamples - start;

    const assetId = await this.#assets.importAsset(
      encodeWav(sliced, decoded.sampleRate, 32),
      { kind: "audio", mime: "audio/wav", name: `${clip.name}.wav`, producedBy: "audio-env" },
    );
    if (!options.forceNew) {
      this.#documents.update<AudioDocumentState>(document.id, (state) => {
        const found = state.tracks.find((item) => item.id === target.trackId)?.clips.find((item) => item.id === target.clipId);
        if (found) { found.assetId = assetId; found.offsetSamples = handleOffset; found.sourceDurationSamples = sliced[0]?.length ?? 0; }
      });
      this.#documents.addAssetRef(document.id, assetId);
    }
    return { assetId, title: clip.name, handleOffset };
  }

  async exportAsAsset(document: VravioDocument<AudioDocumentState>, options: ExportOptions): Promise<Uint8Array> {
    if (options.kind !== "audio") throw new Error(`An audio document cannot be exported as ${options.kind}`);
    const state = document.state;
    const decoded = new Map<string, ReturnType<typeof decodeWav>>();
    for (const track of state.tracks) for (const clip of track.clips) {
      if (decoded.has(clip.assetId)) continue;
      const bytes = await this.#assets.read(clip.assetId as AssetId);
      if (bytes) decoded.set(clip.assetId, decodeWav(bytes));
    }
    const mixed = mixdownAudioDocument(state, (assetId) => decoded.get(assetId));
    // Lossless intermediate revisions get full float headroom; a final delivery export would
    // ask for 16-bit through a dedicated export dialog the way raster's PNG/JPEG choice works —
    // this method is the round-trip path, not the user-facing "Export…" one.
    return encodeWav(mixed, state.sampleRate, options.lossless ? 32 : 16);
  }

  onAssetRevised(document: VravioDocument<AudioDocumentState>, assetId: AssetId, rev: number, note?: string): void {
    void note;
    const affected = document.state.tracks.some((track) => track.clips.some((clip) => clip.assetId === assetId));
    if (!affected) return;

    this.#pending = this.#pending
      .catch(() => undefined)
      .then(async () => {
        const bytes = await this.#assets.read(assetId, rev);
        if (!bytes) return;
        const decoded = decodeWav(bytes);
        const sourceDuration = decoded.channelData[0]?.length ?? 0;
        this.#documents.update<AudioDocumentState>(document.id, (state) => {
          for (const track of state.tracks) for (const clip of track.clips) {
            if (clip.assetId !== assetId) continue;
            clip.sourceSampleRate = decoded.sampleRate;
            clip.sourceDurationSamples = sourceDuration;
            // A shorter revision can leave offset/duration pointing past the new end —
            // clamped in place rather than left to read silence or throw during playback.
            clip.offsetSamples = Math.min(clip.offsetSamples, sourceDuration);
            clip.durationSamples = Math.min(clip.durationSamples, sourceDuration - clip.offsetSamples);
          }
        });
      });
  }

  async relinkTarget(document: VravioDocument<AudioDocumentState>, target: ParentTarget, newAssetId: AssetId): Promise<void> {
    if (target.kind !== "audio-clip") throw new Error(`An audio document has no ${target.kind}`);
    const bytes = await this.#assets.read(newAssetId);
    if (!bytes) throw new Error(`Asset ${newAssetId} has no bytes`);
    const decoded = decodeWav(bytes);
    const sourceDuration = decoded.channelData[0]?.length ?? 0;

    this.#documents.update<AudioDocumentState>(document.id, (state) => {
      const clip = state.tracks.find((item) => item.id === target.trackId)?.clips.find((item) => item.id === target.clipId);
      if (!clip) throw new Error(`Unknown clip: ${target.trackId}/${target.clipId}`);
      clip.assetId = newAssetId;
      clip.sourceSampleRate = decoded.sampleRate;
      clip.sourceDurationSamples = sourceDuration;
      clip.offsetSamples = Math.min(clip.offsetSamples, sourceDuration);
      clip.durationSamples = Math.min(clip.durationSamples, sourceDuration - clip.offsetSamples);
    });
    this.#documents.addAssetRef(document.id, newAssetId);
  }

  describeChanges(document: VravioDocument<AudioDocumentState>): string {
    const clipCount = document.state.tracks.reduce((sum, track) => sum + track.clips.length, 0);
    const trackCount = document.state.tracks.length;
    return `Audio edit (${clipCount} clip${clipCount === 1 ? "" : "s"} on ${trackCount} track${trackCount === 1 ? "" : "s"})`;
  }

  /** Adds a track from an imported audio asset without opening a document for it — the
   * audio-side counterpart to `RasterEnvironment.appendAssetAsLayer`. */
  async appendAssetAsTrack(document: VravioDocument<AudioDocumentState>, assetId: AssetId, name?: string): Promise<void> {
    const bytes = await this.#assets.read(assetId);
    if (!bytes) throw new Error(`Asset ${assetId} has no bytes`);
    const decoded = decodeWav(bytes);
    const durationSamples = decoded.channelData[0]?.length ?? 0;
    const track = createAudioTrack(name ?? this.#assets.mustGet(assetId).name);
    track.clips.push(createAudioClip(assetId, durationSamples, durationSamples, decoded.sampleRate, { name: track.name }));
    this.#documents.update<AudioDocumentState>(document.id, (state) => { state.tracks.push(track); });
    this.#documents.addAssetRef(document.id, assetId);
  }
}
