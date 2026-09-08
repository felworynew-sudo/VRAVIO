import { beforeEach, describe, expect, it } from "vitest";
import { AssetStore, DocumentStore, MemoryStorageAdapter, type AssetId } from "@vravio/kernel";
import { VideoEnvironment, type VideoAssetMeta } from "./environment";
import type { VideoDocumentState } from "./types";

const SAMPLE_META: VideoAssetMeta = { durationFrames: 900, width: 1920, height: 1080, frameRate: 30 };

let nextFakeByte = 1;
/** AssetStore dedupes imports by content hash (docs/master-plan.md's own note on this same trap
 * for audio's pitch-shift test), so every fixture here needs bytes that actually differ — a
 * fixed byte sequence would silently return the *first* asset's id (and its original meta) on
 * every later call. */
async function importVideoAsset(assets: AssetStore, name: string, meta: VideoAssetMeta = SAMPLE_META): Promise<AssetId> {
  return assets.importAsset(new Uint8Array([nextFakeByte++, 2, 3, 4]), { kind: "video", mime: "video/mp4", name, meta: meta as unknown as Record<string, unknown> }) as Promise<AssetId>;
}

describe("VideoEnvironment", () => {
  let documents: DocumentStore;
  let assets: AssetStore;
  let environment: VideoEnvironment;

  beforeEach(async () => {
    documents = new DocumentStore();
    assets = new AssetStore(new MemoryStorageAdapter());
    await assets.initialize();
    environment = new VideoEnvironment({ documents, assets });
  });

  it("creates an empty document with one empty video track", async () => {
    const document = await environment.createEmpty({ name: "Empty" });
    expect(document.state.tracks).toHaveLength(1);
    expect(document.state.tracks[0]!.kind).toBe("video");
    expect(document.state.tracks[0]!.clips).toHaveLength(0);
    expect(document.name).toBe("Empty");
  });

  it("creates a document from a video asset carrying probed metadata, with one clip spanning it", async () => {
    const assetId = await importVideoAsset(assets, "clip.mp4");

    const document = await environment.createFromAsset(assetId, { title: "Clip" });
    expect(document.state.frameRate).toBe(30);
    expect(document.state.width).toBe(1920);
    expect(document.state.height).toBe(1080);
    const clip = document.state.tracks[0]!.clips[0]!;
    expect(clip.assetId).toBe(assetId);
    expect(clip.durationFrames).toBe(900);
    expect(clip.sourceDurationFrames).toBe(900);
    expect(document.assetRefs.has(assetId)).toBe(true);
    expect(document.origin).toMatchObject({ kind: "asset", assetId });
  });

  it("refuses a video asset with no probed metadata rather than guessing a duration", async () => {
    const assetId = await assets.importAsset(new Uint8Array([1, 2]), { kind: "video", mime: "video/mp4", name: "raw.mp4" });
    await expect(environment.createFromAsset(assetId as AssetId)).rejects.toThrow(/probed video metadata/);
  });

  it("relinks a clip to a new asset and refreshes its cached source fields", async () => {
    const original = await importVideoAsset(assets, "a.mp4");
    const document = await environment.createFromAsset(original);
    const track = document.state.tracks[0]!, clip = track.clips[0]!;

    const replacement = await importVideoAsset(assets, "b.mp4", { durationFrames: 300, width: 1280, height: 720, frameRate: 24 });
    await environment.relinkTarget(document, { kind: "video-clip", trackId: track.id, clipId: clip.id }, replacement);

    const updated = documents.get<VideoDocumentState>(document.id)!.state.tracks[0]!.clips[0]!;
    expect(updated.assetId).toBe(replacement);
    expect(updated.sourceFrameRate).toBe(24);
    expect(updated.sourceDurationFrames).toBe(300);
    // The old clip window (900 frames) no longer fits the new 300-frame source.
    expect(updated.offsetFrames + updated.durationFrames).toBeLessThanOrEqual(300);
  });

  it("onAssetRevised is a no-op — video containers aren't self-describing the way WAV is, so re-probing after a revision is apps/web's job, not this hook's", async () => {
    const assetId = await importVideoAsset(assets, "a.mp4");
    const document = await environment.createFromAsset(assetId);
    const before = documents.get<VideoDocumentState>(document.id)!.state.tracks[0]!.clips[0]!.durationFrames;

    expect(() => environment.onAssetRevised(document, assetId, 2)).not.toThrow();

    const after = documents.get<VideoDocumentState>(document.id)!.state.tracks[0]!.clips[0]!.durationFrames;
    expect(after).toBe(before);
  });

  it("describes changes with a track/clip summary", async () => {
    const document = await environment.createEmpty();
    expect(environment.describeChanges(document)).toMatch(/0 clips? on 1 track/);
  });

  it("refuses a target kind a video document does not have", async () => {
    const document = await environment.createEmpty();
    await expect(environment.extractAsset(document, { kind: "raster-layer", layerId: "x" }, { handles: 0, forceNew: false })).rejects.toThrow();
  });

  it("refuses to extract or export until a decode/encode pipeline exists — fails loudly rather than returning wrong media", async () => {
    const assetId = await importVideoAsset(assets, "a.mp4");
    const document = await environment.createFromAsset(assetId);
    const track = document.state.tracks[0]!, clip = track.clips[0]!;
    await expect(environment.extractAsset(document, { kind: "video-clip", trackId: track.id, clipId: clip.id }, { handles: 0, forceNew: false })).rejects.toThrow(/not yet built/);
    await expect(environment.exportAsAsset(document, { kind: "video", lossless: true })).rejects.toThrow(/not yet built/);
  });

  it("appends an asset as a new track without opening a document for it", async () => {
    const document = await environment.createEmpty();
    const assetId = await importVideoAsset(assets, "music.mp4", { durationFrames: 300, width: 1920, height: 1080, frameRate: 30 });
    await environment.appendAssetAsTrack(document, assetId, "audio", "Music");

    const updated = documents.get<VideoDocumentState>(document.id)!.state;
    expect(updated.tracks).toHaveLength(2);
    expect(updated.tracks[1]!.kind).toBe("audio");
    expect(updated.tracks[1]!.clips[0]!.assetId).toBe(assetId);
  });
});
