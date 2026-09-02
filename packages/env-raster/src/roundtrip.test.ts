import { beforeEach, describe, expect, it } from "vitest";
import {
  AssetStore, DocumentStore, EnvironmentRegistry, HistoryManager, MemoryStorageAdapter, RoundTripManager,
  type AssetId, type VravioDocument,
} from "@vravio/kernel";
import { RasterEnvironment } from "./environment";
import { createRasterLayer } from "./document";
import { appendLayer, flattenRasterLayers } from "./layer-tree";
import { decodeRasterAsset, encodeRasterAsset, isRasterAsset } from "./raster-asset";
import type { RasterDocumentState } from "./types";

const W = 8, H = 6;

const solid = (r: number, g: number, b: number, a = 255) => {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let index = 0; index < pixels.length; index += 4) { pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = a; }
  return pixels;
};

const firstPixel = (pixels: Uint8ClampedArray) => [pixels[0], pixels[1], pixels[2], pixels[3]];

describe("raster asset container", () => {
  it("round-trips pixels and their dimensions", () => {
    const pixels = solid(10, 20, 30);

    const decoded = decodeRasterAsset(encodeRasterAsset(pixels, W, H));

    expect(decoded.width).toBe(W);
    expect(decoded.height).toBe(H);
    expect([...decoded.pixels]).toEqual([...pixels]);
  });

  it("hands back a copy, not a view into the encoded bytes", () => {
    const bytes = encodeRasterAsset(solid(10, 20, 30), W, H);
    const decoded = decodeRasterAsset(bytes);

    decoded.pixels[0] = 200;

    expect(bytes[16]).toBe(10);
  });

  it("refuses bytes that are not one of ours", () => {
    expect(isRasterAsset(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBe(false);
    expect(() => decodeRasterAsset(new Uint8Array(20))).toThrow(/wrong magic/);
    expect(() => decodeRasterAsset(new Uint8Array(4))).toThrow(/too short/);
  });

  it("refuses a header that disagrees with the payload", () => {
    const bytes = encodeRasterAsset(solid(1, 2, 3), W, H);

    // Truncation has to be caught here rather than producing a document with a
    // buffer the compositor will read past the end of.
    expect(() => decodeRasterAsset(bytes.slice(0, bytes.length - 4))).toThrow(/carries/);
  });

  it("refuses to encode a mismatched buffer", () => {
    expect(() => encodeRasterAsset(new Uint8ClampedArray(8), W, H)).toThrow(/bytes of pixels/);
    expect(() => encodeRasterAsset(solid(1, 1, 1), 0, H)).toThrow(/positive integers/);
  });
});

describe("raster round-trip", () => {
  let documents: DocumentStore;
  let assets: AssetStore;
  let environment: RasterEnvironment;
  let roundtrip: RoundTripManager;
  let histories: Map<string, HistoryManager>;

  beforeEach(async () => {
    documents = new DocumentStore();
    assets = new AssetStore(new MemoryStorageAdapter());
    await assets.initialize();
    environment = new RasterEnvironment({ documents, assets });
    const environments = new EnvironmentRegistry();
    environments.register(environment);
    histories = new Map();
    roundtrip = new RoundTripManager({ documents, assets, environments, historyFor: (id) => histories.get(id) });
  });

  /** A parent with two layers, the top one red. */
  const parentDocument = async (): Promise<VravioDocument<RasterDocumentState>> => {
    const document = await environment.createEmpty({ width: W, height: H, name: "Parent" });
    const layer = createRasterLayer(W, H, "Red");
    layer.pixels = solid(255, 0, 0);
    documents.update<RasterDocumentState>(document.id, (state) => { appendLayer(state, layer); });
    histories.set(document.id, new HistoryManager({ limit: 20 }));
    return document;
  };

  const topLayer = (document: VravioDocument<RasterDocumentState>) =>
    flattenRasterLayers(document.state.layers).find((layer) => layer.name === "Red")!;

  it("opens a layer as its own document carrying the same pixels", async () => {
    const parent = await parentDocument();
    const layer = topLayer(parent);

    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: layer.id }, targetEnv: "raster" });
    const child = documents.get<RasterDocumentState>(session.childDocId)!;

    expect(child.state.width).toBe(W);
    expect(firstPixel(child.state.layers[0]!.pixels)).toEqual([255, 0, 0, 255]);
    expect(child.name).toBe("Red");
    expect(child.provenance).toMatchObject({ parentDocId: parent.id, writeBack: "replace-asset" });
  });

  it("binds the layer to the asset so the parent and child share one reference", async () => {
    const parent = await parentDocument();
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: topLayer(parent).id }, targetEnv: "raster" });

    // Both sides point at the same asset; that shared reference is the whole
    // mechanism, not a convenience.
    expect(topLayer(documents.get<RasterDocumentState>(parent.id)!).pixelAssetId).toBe(session.assetId);
    expect(documents.get(session.childDocId)!.assetRefs.has(session.assetId)).toBe(true);
  });

  it("upgrades a layer bound to a buffer that predates the container", async () => {
    const parent = await parentDocument();
    const layer = topLayer(parent);
    // How brush commits stored a layer before the bytes carried their size.
    const legacy = await assets.importAsset(new Uint8Array(solid(255, 0, 0).buffer.slice(0)), { kind: "image", name: "Red.pixels.raw" });
    documents.update<RasterDocumentState>(parent.id, (state) => {
      flattenRasterLayers(state.layers).find((item) => item.id === layer.id)!.pixelAssetId = legacy;
    });

    // Handing those bytes to anything that did not already know the document
    // fails at the far end, so extraction brings the asset up to date first.
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: layer.id }, targetEnv: "raster" });

    expect(session.assetId).toBe(legacy);
    expect(documents.get<RasterDocumentState>(session.childDocId)!.state.width).toBe(W);
    expect(firstPixel(documents.get<RasterDocumentState>(session.childDocId)!.state.layers[0]!.pixels)).toEqual([255, 0, 0, 255]);
  });

  it("sends the child's work back into the parent's layer", async () => {
    const parent = await parentDocument();
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: topLayer(parent).id }, targetEnv: "raster" });

    documents.update<RasterDocumentState>(session.childDocId, (state) => { state.layers[0]!.pixels = solid(0, 0, 255); });
    await roundtrip.apply(session.childDocId);
    await environment.whenSettled();

    expect(firstPixel(topLayer(documents.get<RasterDocumentState>(parent.id)!).pixels)).toEqual([0, 0, 255, 255]);
    expect(roundtrip.sessionOf(session.childDocId)?.status).toBe("applied");
  });

  it("does not make the child reload the bytes it just produced", async () => {
    const parent = await parentDocument();
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: topLayer(parent).id }, targetEnv: "raster" });

    // The child holds a second, hidden layer that the export flattens away.
    // Reloading it from its own export would silently delete that work.
    documents.update<RasterDocumentState>(session.childDocId, (state) => {
      state.layers[0]!.pixels = solid(0, 0, 255);
      const hidden = createRasterLayer(W, H, "Notes");
      hidden.visible = false;
      appendLayer(state, hidden);
    });
    await roundtrip.apply(session.childDocId);
    await environment.whenSettled();

    expect(documents.get<RasterDocumentState>(session.childDocId)!.state.layers).toHaveLength(2);
  });

  it("lets the parent undo the applied result", async () => {
    const parent = await parentDocument();
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: topLayer(parent).id }, targetEnv: "raster" });

    documents.update<RasterDocumentState>(session.childDocId, (state) => { state.layers[0]!.pixels = solid(0, 0, 255); });
    await roundtrip.apply(session.childDocId);
    await environment.whenSettled();

    await histories.get(parent.id)!.undo();
    await environment.whenSettled();

    // Undo moves the asset head, and the parent hears about it through exactly
    // the same path as the apply did.
    expect(firstPixel(topLayer(documents.get<RasterDocumentState>(parent.id)!).pixels)).toEqual([255, 0, 0, 255]);

    await histories.get(parent.id)!.redo();
    await environment.whenSettled();
    expect(firstPixel(topLayer(documents.get<RasterDocumentState>(parent.id)!).pixels)).toEqual([0, 0, 255, 255]);
  });

  it("leaves the original asset untouched when branching", async () => {
    const parent = await parentDocument();
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: topLayer(parent).id }, targetEnv: "raster", branch: true });
    const originalRevisions = assets.mustGet(session.assetId).revisions.length;

    documents.update<RasterDocumentState>(session.childDocId, (state) => { state.layers[0]!.pixels = solid(0, 255, 0); });
    await roundtrip.apply(session.childDocId);
    await environment.whenSettled();

    const layer = topLayer(documents.get<RasterDocumentState>(parent.id)!);
    expect(assets.mustGet(session.assetId).revisions).toHaveLength(originalRevisions);
    expect(layer.pixelAssetId).not.toBe(session.assetId);
    expect(firstPixel(layer.pixels)).toEqual([0, 255, 0, 255]);
  });

  it("stops writing back once detached", async () => {
    const parent = await parentDocument();
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: topLayer(parent).id }, targetEnv: "raster" });

    roundtrip.detach(session.childDocId);

    expect(documents.get(session.childDocId)!.provenance).toBeNull();
    await expect(roundtrip.apply(session.childDocId)).rejects.toThrow(/no longer linked/);
  });

  it("honours a layer pinned to a revision", async () => {
    const parent = await parentDocument();
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: topLayer(parent).id }, targetEnv: "raster" });
    documents.update<RasterDocumentState>(parent.id, (state) => {
      const layer = flattenRasterLayers(state.layers).find((item) => item.name === "Red")!;
      layer.smartSource = { assetId: session.assetId, pinnedRev: "0", sourceKind: "raster" };
    });

    documents.update<RasterDocumentState>(session.childDocId, (state) => { state.layers[0]!.pixels = solid(0, 0, 255); });
    await roundtrip.apply(session.childDocId);
    await environment.whenSettled();

    // Pinning exists so a source can change without moving what depends on it.
    expect(firstPixel(topLayer(documents.get<RasterDocumentState>(parent.id)!).pixels)).toEqual([255, 0, 0, 255]);
  });

  it("places a result of a different size instead of stretching it", async () => {
    const parent = await parentDocument();
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: topLayer(parent).id }, targetEnv: "raster" });

    // The child was cropped in the other editor.
    documents.update<RasterDocumentState>(session.childDocId, (state) => {
      state.width = 4; state.height = 3;
      state.layers[0]!.pixels = new Uint8ClampedArray(4 * 3 * 4).fill(255);
    });
    await roundtrip.apply(session.childDocId);
    await environment.whenSettled();

    const layer = topLayer(documents.get<RasterDocumentState>(parent.id)!);
    expect(layer.pixels.length).toBe(W * H * 4);
    expect(firstPixel(layer.pixels)).toEqual([255, 255, 255, 255]);
    // Beyond the returned area the layer is cleared rather than stretched.
    expect(layer.pixels[(0 * W + 5) * 4 + 3]).toBe(0);
  });

  it("refuses targets a raster document does not have", async () => {
    const parent = await parentDocument();

    await expect(roundtrip.open({ parentDocId: parent.id, target: { kind: "audio-clip", trackId: "t", clipId: "c" }, targetEnv: "raster" }))
      .rejects.toThrow(/no audio-clip/);
  });

  it("reports the sessions still hanging off a parent", async () => {
    const parent = await parentDocument();
    const session = await roundtrip.open({ parentDocId: parent.id, target: { kind: "raster-layer", layerId: topLayer(parent).id }, targetEnv: "raster" });

    expect(roundtrip.sessionsOfParent(parent.id)).toHaveLength(1);
    roundtrip.detach(session.childDocId);
    expect(roundtrip.sessionsOfParent(parent.id)).toHaveLength(0);
  });
});

describe("environment registry", () => {
  it("names the kind that is missing rather than failing obscurely", () => {
    const registry = new EnvironmentRegistry();

    expect(() => registry.get("audio")).toThrow(/No environment registered for "audio"/);
    expect(registry.find("audio")).toBeUndefined();
    expect(registry.has("audio")).toBe(false);
  });

  it("lists what this build can open", async () => {
    const documents = new DocumentStore();
    const assets = new AssetStore(new MemoryStorageAdapter());
    await assets.initialize();
    const registry = new EnvironmentRegistry();
    registry.register(new RasterEnvironment({ documents, assets }));

    expect(registry.kinds).toEqual(["raster"]);
    expect(registry.get("raster").kind).toBe("raster");
  });
});

describe("raster environment on its own", () => {
  it("exports the flattened picture, not the layer stack", async () => {
    const documents = new DocumentStore();
    const assets = new AssetStore(new MemoryStorageAdapter());
    await assets.initialize();
    const environment = new RasterEnvironment({ documents, assets });

    const document = await environment.createEmpty({ width: W, height: H });
    documents.update<RasterDocumentState>(document.id, (state) => {
      state.layers[0]!.pixels = solid(255, 0, 0);
      const top = createRasterLayer(W, H, "Blue");
      top.pixels = solid(0, 0, 255);
      top.opacity = 0.5;
      appendLayer(state, top);
    });

    const decoded = decodeRasterAsset(await environment.exportAsAsset(document, { kind: "image", lossless: true }));

    // Half blue over red: the export is what the user sees, composited.
    expect(decoded.pixels[0]).toBeGreaterThan(100);
    expect(decoded.pixels[2]).toBeGreaterThan(100);
  });

  it("refuses to export as a kind it cannot produce", async () => {
    const documents = new DocumentStore();
    const assets = new AssetStore(new MemoryStorageAdapter());
    await assets.initialize();
    const environment = new RasterEnvironment({ documents, assets });
    const document = await environment.createEmpty({ width: W, height: H });

    await expect(environment.exportAsAsset(document, { kind: "audio", lossless: true })).rejects.toThrow(/cannot be exported as audio/);
  });

  it("adds an imported asset as a layer bound to it", async () => {
    const documents = new DocumentStore();
    const assets = new AssetStore(new MemoryStorageAdapter());
    await assets.initialize();
    const environment = new RasterEnvironment({ documents, assets });
    const document = await environment.createEmpty({ width: W, height: H });
    const assetId = await assets.importAsset(encodeRasterAsset(solid(9, 9, 9), W, H), { kind: "image", name: "photo" }) as AssetId;

    const layer = await environment.appendAssetAsLayer(document, assetId, "Photo");

    expect(layer.pixelAssetId).toBe(assetId);
    expect(document.assetRefs.has(assetId)).toBe(true);
    expect(flattenRasterLayers(document.state.layers)).toHaveLength(2);
  });
});
