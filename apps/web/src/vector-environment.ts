import type { AssetId, AssetStore, DocumentStore, Environment, ExportOptions, ExtractOptions, ExtractedAsset, ParentTarget, VravioDocument } from "@vravio/kernel";
import { RASTER_ASSET_MIME, decodeRasterAsset, encodeRasterAsset, isRasterAsset } from "@vravio/env-raster";
import { createImageShape, createVectorDocument, pathData, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";

export interface VectorEnvironmentOptions {
  readonly documents: DocumentStore;
  readonly assets: AssetStore;
}

const defaultName = "Vector drawing (Векторный рисунок)";

/**
 * The vector editor, as the kernel sees it.
 *
 * An image placed in a vector document never carries its own pixels — it holds
 * `pixelAssetId`, a reference into the same asset store a raster layer points
 * into. That single fact is the whole round-trip: extracting an image shape
 * for editing elsewhere just hands over the reference it already had, and
 * taking a revision back is nothing more than the reference now resolving to
 * newer bytes. No pixel ever crosses between this file and the raster one.
 */
export class VectorEnvironment implements Environment<VectorDocumentState> {
  readonly kind = "vector" as const;
  readonly #documents: DocumentStore;
  readonly #assets: AssetStore;

  constructor(options: VectorEnvironmentOptions) {
    this.#documents = options.documents;
    this.#assets = options.assets;
  }

  async createEmpty(options: { name?: string; width?: number; height?: number } = {}): Promise<VravioDocument<VectorDocumentState>> {
    const state = createVectorDocument(options.width ?? 1280, options.height ?? 720);
    return this.#documents.create("vector", options.name?.trim() || defaultName, state);
  }

  /** Places the asset's picture as a single image shape, sized to its pixels 1:1 — the vector
   * equivalent of raster's "open this picture as a document" bootstrap. */
  async createFromAsset(assetId: AssetId, options: { title?: string } = {}): Promise<VravioDocument<VectorDocumentState>> {
    const record = this.#assets.mustGet(assetId);
    const bytes = await this.#assets.read(assetId);
    if (!bytes) throw new Error(`Asset ${assetId} has no bytes at revision ${record.head}`);
    const image = decodeRasterAsset(bytes);

    const state = createVectorDocument(image.width, image.height);
    const shape = createImageShape(0, 0, image.width, image.height, assetId, options.title ?? record.name);
    state.shapes.push(shape);
    state.activeShapeId = shape.id;
    state.selection = [shape.id];

    return this.#documents.create("vector", options.title ?? record.name, state, {
      origin: { kind: "asset", assetId, rev: record.head, name: record.name },
      assetRefs: [assetId],
    });
  }

  async extractAsset(document: VravioDocument<VectorDocumentState>, target: ParentTarget, options: ExtractOptions): Promise<ExtractedAsset> {
    if (target.kind !== "vector-node") throw new Error(`A vector document has no ${target.kind}`);
    const shape = document.state.shapes.find((item) => item.id === target.nodeId);
    if (!shape || shape.kind !== "image") throw new Error(`Shape ${target.nodeId} is not an image`);

    // Already bound and nobody asked for a copy: hand over the same asset, so the child's
    // revisions land straight on what this document is drawing — see RasterEnvironment's own
    // extractAsset, which this mirrors exactly for the same reason.
    if (!options.forceNew && this.#assets.has(shape.pixelAssetId as AssetId)) {
      const bytes = await this.#assets.read(shape.pixelAssetId as AssetId);
      if (bytes && isRasterAsset(bytes)) return { assetId: shape.pixelAssetId as AssetId, title: shape.name, handleOffset: 0 };
    }

    const bytes = await this.#assets.read(shape.pixelAssetId as AssetId);
    if (!bytes) throw new Error(`Asset ${shape.pixelAssetId} has no bytes`);
    const assetId = await this.#assets.importAsset(bytes, { kind: "image", mime: RASTER_ASSET_MIME, name: `${shape.name}.vraster`, producedBy: "vector-env" });
    if (!options.forceNew) {
      this.#documents.update<VectorDocumentState>(document.id, (state) => {
        const found = state.shapes.find((item) => item.id === target.nodeId);
        if (found && found.kind === "image") found.pixelAssetId = assetId;
      });
      this.#documents.addAssetRef(document.id, assetId);
    }
    return { assetId, title: shape.name, handleOffset: 0 };
  }

  /** Rasterizes every visible shape onto an offscreen canvas — the only place in this package
   * that touches the DOM, and only because turning vector geometry into pixels means painting
   * it. Images blit their bitmap directly; every other shape reuses the exact `d` string the
   * on-screen SVG renders, via Path2D, so the export can never drift from what the canvas shows. */
  async exportAsAsset(document: VravioDocument<VectorDocumentState>, options: ExportOptions): Promise<Uint8Array> {
    if (options.kind !== "image") throw new Error(`A vector document cannot be exported as ${options.kind}`);
    const state = document.state;
    const canvas = window.document.createElement("canvas");
    canvas.width = state.width;
    canvas.height = state.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas context is unavailable");

    for (const shape of state.shapes) {
      if (!shape.visible) continue;
      context.save();
      context.globalAlpha = shape.style.opacity;
      if (shape.kind === "image") {
        const bytes = await this.#assets.read(shape.pixelAssetId as AssetId);
        if (bytes) {
          const image = decodeRasterAsset(bytes);
          const bitmap = await imageBitmapFromPixels(image.pixels, image.width, image.height);
          context.drawImage(bitmap, shape.x, shape.y, shape.width, shape.height);
          bitmap.close();
        }
      } else {
        paintShape(context, shape);
      }
      context.restore();
    }

    const pixels = context.getImageData(0, 0, state.width, state.height).data as unknown as Uint8ClampedArray;
    return encodeRasterAsset(pixels, state.width, state.height);
  }

  onAssetRevised(document: VravioDocument<VectorDocumentState>, assetId: AssetId, rev: number, note?: string): void {
    void rev; void note;
    // An image shape's pixelAssetId is the ONLY thing tying it to its bitmap — the shape carries
    // no pixels of its own for a revision to overwrite. So there is nothing to copy in here; the
    // shape already points at the assetId that just gained a new revision, and the workspace's
    // own bitmap cache (keyed by assetId *and* revision) notices the head moved and refetches.
    // What has to happen is a re-render, and a document.update touching nothing but bumping the
    // revision counter is exactly that — the same reason RasterEnvironment's smart-layer path
    // exists, just without pixels to write back.
    const affected = document.state.shapes.some((shape) => shape.kind === "image" && shape.pixelAssetId === assetId);
    if (!affected) return;
    this.#documents.update<VectorDocumentState>(document.id, () => { /* touch only: see comment above */ });
  }

  async relinkTarget(document: VravioDocument<VectorDocumentState>, target: ParentTarget, newAssetId: AssetId): Promise<void> {
    if (target.kind !== "vector-node") throw new Error(`A vector document has no ${target.kind}`);
    this.#documents.update<VectorDocumentState>(document.id, (state) => {
      const shape = state.shapes.find((item) => item.id === target.nodeId);
      if (!shape) throw new Error(`Unknown shape: ${target.nodeId}`);
      if (shape.kind !== "image") throw new Error(`Shape ${target.nodeId} is not an image`);
      shape.pixelAssetId = newAssetId;
    });
    this.#documents.addAssetRef(document.id, newAssetId);
  }

  describeChanges(document: VravioDocument<VectorDocumentState>): string {
    const shapes = document.state.shapes.filter((shape) => shape.visible);
    return `Vector edit (${shapes.length} of ${document.state.shapes.length} shape${document.state.shapes.length === 1 ? "" : "s"} visible)`;
  }
}

function paintShape(context: CanvasRenderingContext2D, shape: VectorShape): void {
  context.fillStyle = shape.style.fill ?? "transparent";
  context.strokeStyle = shape.style.stroke ?? "transparent";
  context.lineWidth = shape.style.strokeWidth;
  if (shape.kind === "rectangle") {
    const path = new Path2D();
    if (shape.cornerRadius > 0) path.roundRect(shape.x, shape.y, shape.width, shape.height, shape.cornerRadius);
    else path.rect(shape.x, shape.y, shape.width, shape.height);
    if (shape.style.fill) context.fill(path);
    if (shape.style.stroke) context.stroke(path);
  } else if (shape.kind === "ellipse") {
    const path = new Path2D();
    path.ellipse(shape.x + shape.width / 2, shape.y + shape.height / 2, shape.width / 2, shape.height / 2, 0, 0, Math.PI * 2);
    if (shape.style.fill) context.fill(path);
    if (shape.style.stroke) context.stroke(path);
  } else if (shape.kind === "line") {
    context.beginPath();
    context.moveTo(shape.x1, shape.y1);
    context.lineTo(shape.x2, shape.y2);
    if (shape.style.stroke) context.stroke();
  } else if (shape.kind === "path") {
    const path = new Path2D(pathData(shape.points, shape.closed));
    if (shape.style.fill) context.fill(path);
    if (shape.style.stroke) context.stroke(path);
  } else if (shape.kind === "text") {
    context.font = `${shape.fontSize}px ${shape.fontFamily}`;
    context.textAlign = shape.align === "center" ? "center" : shape.align === "right" ? "right" : "left";
    context.textBaseline = "alphabetic";
    if (shape.style.fill) context.fillText(shape.value, shape.x, shape.y);
    if (shape.style.stroke) context.strokeText(shape.value, shape.x, shape.y);
  }
}

async function imageBitmapFromPixels(pixels: Uint8ClampedArray, width: number, height: number): Promise<ImageBitmap> {
  const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
  return createImageBitmap(imageData);
}
