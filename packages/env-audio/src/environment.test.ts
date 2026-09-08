import { beforeEach, describe, expect, it } from "vitest";
import { AssetStore, DocumentStore, MemoryStorageAdapter, type AssetId } from "@vravio/kernel";
import { AudioEnvironment } from "./environment";
import { encodeWav, decodeWav } from "./wav";
import type { AudioDocumentState } from "./types";

function sineWave(length: number, frequency = 0.05): Float32Array {
  const wave = new Float32Array(length);
  for (let i = 0; i < length; i += 1) wave[i] = Math.sin(2 * Math.PI * frequency * i) * 0.5;
  return wave;
}

describe("AudioEnvironment", () => {
  let documents: DocumentStore;
  let assets: AssetStore;
  let environment: AudioEnvironment;

  beforeEach(async () => {
    documents = new DocumentStore();
    assets = new AssetStore(new MemoryStorageAdapter());
    await assets.initialize();
    environment = new AudioEnvironment({ documents, assets });
  });

  it("creates an empty document with one empty track", async () => {
    const document = await environment.createEmpty({ name: "Empty" });
    expect(document.state.tracks).toHaveLength(1);
    expect(document.state.tracks[0]!.clips).toHaveLength(0);
    expect(document.name).toBe("Empty");
  });

  it("creates a document from a WAV asset, with one clip spanning it", async () => {
    const wav = encodeWav([sineWave(1000)], 44100, 16);
    const assetId = await assets.importAsset(wav, { kind: "audio", mime: "audio/wav", name: "voice.wav" });

    const document = await environment.createFromAsset(assetId, { title: "Voice" });
    expect(document.state.sampleRate).toBe(44100);
    expect(document.state.channels).toBe(1);
    const clip = document.state.tracks[0]!.clips[0]!;
    expect(clip.assetId).toBe(assetId);
    expect(clip.durationSamples).toBe(1000);
    expect(clip.sourceDurationSamples).toBe(1000);
    expect(document.assetRefs.has(assetId)).toBe(true);
    expect(document.origin).toMatchObject({ kind: "asset", assetId });
  });

  it("extracts a clip's exact windowed range (plus handles) as a new asset", async () => {
    const wav = encodeWav([sineWave(2000)], 44100, 16);
    const assetId = await assets.importAsset(wav, { kind: "audio", mime: "audio/wav", name: "source.wav" });
    const document = await environment.createFromAsset(assetId);

    // Trim the clip to a 500-sample window starting at offset 300.
    documents.update<AudioDocumentState>(document.id, (state) => {
      const clip = state.tracks[0]!.clips[0]!;
      clip.offsetSamples = 300;
      clip.durationSamples = 500;
    });
    const track = document.state.tracks[0]!, clip = track.clips[0]!;

    const extracted = await environment.extractAsset(document, { kind: "audio-clip", trackId: track.id, clipId: clip.id }, { handles: 50, forceNew: false });
    const extractedBytes = await assets.read(extracted.assetId as AssetId);
    const decoded = decodeWav(extractedBytes!);
    expect(decoded.channelData[0]).toHaveLength(600); // 500 + 50 handles each side, clamped
    expect(extracted.handleOffset).toBe(50);
  });

  it("mixes down and exports the whole document as a WAV asset", async () => {
    const wav = encodeWav([sineWave(1000)], 48000, 16);
    const assetId = await assets.importAsset(wav, { kind: "audio", mime: "audio/wav", name: "a.wav" });
    const document = await environment.createFromAsset(assetId);

    const exported = await environment.exportAsAsset(document, { kind: "audio", lossless: true });
    const decoded = decodeWav(exported);
    expect(decoded.sampleRate).toBe(document.state.sampleRate);
    expect(decoded.channelData[0]!.length).toBeGreaterThan(0);
  });

  it("relinks a clip to a new asset and refreshes its cached source fields", async () => {
    const original = await assets.importAsset(encodeWav([sineWave(1000)], 44100, 16), { kind: "audio", mime: "audio/wav", name: "a.wav" });
    const document = await environment.createFromAsset(original);
    const track = document.state.tracks[0]!, clip = track.clips[0]!;

    const replacement = await assets.importAsset(encodeWav([sineWave(500)], 48000, 16), { kind: "audio", mime: "audio/wav", name: "b.wav" });
    await environment.relinkTarget(document, { kind: "audio-clip", trackId: track.id, clipId: clip.id }, replacement as AssetId);

    const updated = documents.get<AudioDocumentState>(document.id)!.state.tracks[0]!.clips[0]!;
    expect(updated.assetId).toBe(replacement);
    expect(updated.sourceSampleRate).toBe(48000);
    expect(updated.sourceDurationSamples).toBe(500);
    // The old clip window (1000 samples) no longer fits the new 500-sample source.
    expect(updated.offsetSamples + updated.durationSamples).toBeLessThanOrEqual(500);
  });

  it("describes changes with a track/clip summary", async () => {
    const document = await environment.createEmpty();
    expect(environment.describeChanges(document)).toMatch(/0 clips? on 1 track/);
  });

  it("refuses a target kind an audio document does not have", async () => {
    const document = await environment.createEmpty();
    await expect(environment.extractAsset(document, { kind: "raster-layer", layerId: "x" }, { handles: 0, forceNew: false })).rejects.toThrow();
  });
});
