import type {
  AssetId, AssetStore, DocumentStore, Environment, ExportOptions, ExtractOptions, ExtractedAsset, ParentTarget, VravioDocument,
} from "@vravio/kernel";
import { createRasterDocument, createRasterLayer } from "./document";
import { appendLayer, flattenRasterLayers } from "./layer-tree";
import { compositeRasterDocument } from "./render";
import { RASTER_ASSET_MIME, decodeRasterAsset, encodeRasterAsset, isRasterAsset } from "./raster-asset";
import type { RasterDocumentOptions, RasterDocumentState, RasterLayer } from "./types";
import { setLayerPixels } from "./layer-bounds";

export interface RasterEnvironmentOptions {
  readonly documents: DocumentStore;
  readonly assets: AssetStore;
}

export interface CreateRasterOptions extends RasterDocumentOptions {
  readonly name?: string;
  readonly width?: number;
  readonly height?: number;
}

const defaultName = "Raster composition (Растровая композиция)";

/**
 * The raster editor, as the kernel sees it.
 *
 * Everything here is about moving pixels across the boundary as assets. What
 * makes a layer openable somewhere else is that the layer already refers to its
 * bytes by asset rather than holding them: extracting is handing over that
 * reference, and taking the result back is a revision arriving on it.
 */
export class RasterEnvironment implements Environment<RasterDocumentState> {
  readonly kind = "raster" as const;
  readonly #documents: DocumentStore;
  readonly #assets: AssetStore;
  /** Reload work started by onAssetRevised, which the interface cannot await. */
  #pending: Promise<void> = Promise.resolve();

  constructor(options: RasterEnvironmentOptions) {
    this.#documents = options.documents;
    this.#assets = options.assets;
  }

  /**
   * Resolves once every reload triggered by a revision has landed.
   *
   * `onAssetRevised` returns void by contract, but taking up new bytes means
   * reading them, so the work outlives the call. Tests and any caller that
   * needs to look at the result wait here rather than guessing at a delay.
   */
  whenSettled(): Promise<void> { return this.#pending; }

  async createEmpty(options: CreateRasterOptions = {}): Promise<VravioDocument<RasterDocumentState>> {
    const state = createRasterDocument(options.width ?? 1920, options.height ?? 1080, options);
    return this.#documents.create("raster", options.name?.trim() || defaultName, state);
  }

  async createFromAsset(assetId: AssetId, options: { title?: string } = {}): Promise<VravioDocument<RasterDocumentState>> {
    const record = this.#assets.mustGet(assetId);
    const bytes = await this.#assets.read(assetId);
    if (!bytes) throw new Error(`Asset ${assetId} has no bytes at revision ${record.head}`);
    const image = decodeRasterAsset(bytes);

    const state = createRasterDocument(image.width, image.height);
    const layer = state.layers[0]!;
    layer.name = options.title ?? record.name;
    setLayerPixels(layer, image.pixels, image.width, image.height);
    // The layer keeps pointing at the asset, so editing it here and applying
    // sends a revision back down the same reference the parent is holding.
    layer.pixelAssetId = assetId;

    const document = this.#documents.create("raster", options.title ?? record.name, state, {
      origin: { kind: "asset", assetId, rev: record.head, name: record.name },
      assetRefs: [assetId],
    });
    return document;
  }

  async extractAsset(
    document: VravioDocument<RasterDocumentState>,
    target: ParentTarget,
    options: ExtractOptions,
  ): Promise<ExtractedAsset> {
    if (target.kind !== "raster-layer") throw new Error(`A raster document has no ${target.kind}`);
    const layer = flattenRasterLayers(document.state.layers).find((item) => item.id === target.layerId);
    if (!layer) throw new Error(`Unknown layer: ${target.layerId}`);

    // Already bound and nobody asked for a copy: hand over the same asset, so
    // the child's revisions land straight on what the parent is drawing.
    const existing = layer.pixelAssetId as AssetId | undefined;
    if (!options.forceNew && existing && this.#assets.has(existing)) {
      const bytes = await this.#assets.read(existing);
      if (bytes && isRasterAsset(bytes)) return { assetId: existing, title: layer.name, handleOffset: 0 };
      // Bound before the layer buffers carried their dimensions. Nothing that
      // receives this asset could read it, so it is brought up to date in place
      // rather than left as a shape that fails at the far end.
      await this.#assets.commitRevision(existing, encodeRasterAsset(layer.pixels, document.state.width, document.state.height), "raster-env", "Self-describing layer buffer");
      return { assetId: existing, title: layer.name, handleOffset: 0 };
    }

    const assetId = await this.#assets.importAsset(
      encodeRasterAsset(layer.pixels, document.state.width, document.state.height),
      { kind: "image", mime: RASTER_ASSET_MIME, name: `${layer.name}.vraster`, producedBy: "raster-env" },
    );
    // A branch deliberately leaves the layer pointing where it did; the parent
    // is relinked only once the child applies.
    if (!options.forceNew) {
      this.#documents.update<RasterDocumentState>(document.id, (state) => {
        const found = flattenRasterLayers(state.layers).find((item) => item.id === target.layerId);
        if (found) found.pixelAssetId = assetId;
      });
      this.#documents.addAssetRef(document.id, assetId);
    }
    return { assetId, title: layer.name, handleOffset: 0 };
  }

  async exportAsAsset(document: VravioDocument<RasterDocumentState>, options: ExportOptions): Promise<Uint8Array> {
    if (options.kind !== "image") throw new Error(`A raster document cannot be exported as ${options.kind}`);
    const state = document.state;
    // Everything visible, flattened: the parent asked for a picture, not for
    // this document's internal structure.
    return encodeRasterAsset(compositeRasterDocument(state), state.width, state.height);
  }

  onAssetRevised(document: VravioDocument<RasterDocumentState>, assetId: AssetId, rev: number, note?: string): void {
    void note;

    // A layer's pixelAssetId serves two purposes: it names the asset a linked
    // layer follows, and it names where a plain layer keeps its own undo
    // history. Only the first should react to a revision. A revision this
    // environment produced by painting is the second, and reading it back would
    // re-apply the document's own edit to itself — an asset read and a
    // canvas-sized write on every brush stroke, for nothing.
    if (this.#assets.get(assetId)?.revisions.find((revision) => revision.rev === rev)?.producedBy === "raster") return;

    const affected = flattenRasterLayers(document.state.layers).filter((layer) => layer.pixelAssetId === assetId);
    if (affected.length === 0) return;

    this.#pending = this.#pending
      .catch(() => undefined)
      .then(async () => {
        const bytes = await this.#assets.read(assetId, rev);
        if (!bytes) return;
        const image = decodeRasterAsset(bytes);
        this.#documents.update<RasterDocumentState>(document.id, (state) => {
          for (const layer of flattenRasterLayers(state.layers)) {
            if (layer.pixelAssetId !== assetId) continue;
            // A pinned layer asked to be left where it is; that is the whole
            // point of pinning, and honouring it is what keeps round-trip safe.
            if (layer.smartSource?.pinnedRev != null) continue;
            setLayerPixels(layer, fitPixels(image.pixels, image.width, image.height, state.width, state.height), state.width, state.height);
          }
        });
      });
  }

  async relinkTarget(document: VravioDocument<RasterDocumentState>, target: ParentTarget, newAssetId: AssetId): Promise<void> {
    if (target.kind !== "raster-layer") throw new Error(`A raster document has no ${target.kind}`);
    const bytes = await this.#assets.read(newAssetId);
    if (!bytes) throw new Error(`Asset ${newAssetId} has no bytes`);
    const image = decodeRasterAsset(bytes);

    this.#documents.update<RasterDocumentState>(document.id, (state) => {
      const layer = flattenRasterLayers(state.layers).find((item) => item.id === target.layerId);
      if (!layer) throw new Error(`Unknown layer: ${target.layerId}`);
      layer.pixelAssetId = newAssetId;
      setLayerPixels(layer, fitPixels(image.pixels, image.width, image.height, state.width, state.height), state.width, state.height);
    });
    this.#documents.addAssetRef(document.id, newAssetId);
  }

  describeChanges(document: VravioDocument<RasterDocumentState>): string {
    const layers = flattenRasterLayers(document.state.layers).filter((layer) => layer.kind !== "group");
    const visible = layers.filter((layer) => layer.visible).length;
    return `Raster edit (${visible} of ${layers.length} layer${layers.length === 1 ? "" : "s"} visible)`;
  }

  /** Adds a layer from an asset without opening a document for it. */
  async appendAssetAsLayer(document: VravioDocument<RasterDocumentState>, assetId: AssetId, name?: string): Promise<RasterLayer> {
    const bytes = await this.#assets.read(assetId);
    if (!bytes) throw new Error(`Asset ${assetId} has no bytes`);
    const image = decodeRasterAsset(bytes);
    const state = document.state;
    const layer = createRasterLayer(state.width, state.height, name ?? this.#assets.mustGet(assetId).name);
    setLayerPixels(layer, fitPixels(image.pixels, image.width, image.height, state.width, state.height), state.width, state.height);
    layer.pixelAssetId = assetId;
    this.#documents.update<RasterDocumentState>(document.id, (current) => { appendLayer(current, layer); });
    this.#documents.addAssetRef(document.id, assetId);
    return layer;
  }
}

/**
 * Places an image into a buffer of the document's size.
 *
 * A round-trip can come back a different shape — cropped in the other editor,
 * or resized. Stretching would be a silent edit nobody asked for, so the image
 * is placed at the origin and whatever falls outside is left transparent.
 */
function fitPixels(pixels: Uint8ClampedArray, width: number, height: number, targetWidth: number, targetHeight: number): Uint8ClampedArray {
  if (width === targetWidth && height === targetHeight) return pixels;
  const fitted = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const rows = Math.min(height, targetHeight), columns = Math.min(width, targetWidth);
  for (let row = 0; row < rows; row += 1) {
    const from = row * width * 4;
    fitted.set(pixels.subarray(from, from + columns * 4), row * targetWidth * 4);
  }
  return fitted;
}
