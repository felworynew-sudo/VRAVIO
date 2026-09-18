import { builtInLuts } from "./lut";
import { parseHexColor } from "./color";
import { TileStore } from "./tile-store";
import type { PixelSelection, RasterAdjustment, RasterDocumentOptions, RasterDocumentState, RasterLayer, RasterLayerMask } from "./types";

export const makeLayerOrderKey = (index: number): string => Math.max(0, Math.floor(index)).toString(36).padStart(8, "0");

export function createRasterLayer(width: number, height: number, name = "Layer (Слой)"): RasterLayer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError("Raster layer dimensions must be positive integers");
  // Created at canvas size: a tool needs somewhere to paint before it knows
  // where the paint will land. What gets stored is trimmed when the edit is
  // committed, which is where the size actually matters.
  return { id: crypto.randomUUID(), name, bounds: { x: 0, y: 0, width, height }, width, height, tiles: TileStore.empty(width, height), pixelsRevision: 0, visible: true, opacity: 1, fillOpacity: 1, blendMode: "normal", locked: false, kind: "pixel", effects: {}, parentId: null, orderKey: makeLayerOrderKey(0), clipping: false };
}

export function createRasterGroup(width: number, height: number, name = "Group (Группа)"): RasterLayer {
  return { ...createRasterLayer(width, height, name), kind: "group", expanded: true, groupMode: "passThrough" };
}

export function createRasterLayerMask(width: number, height: number, reveal = true): RasterLayerMask {
  const pixels = new Uint8ClampedArray(width * height);
  if (reveal) pixels.fill(255);
  return { tiles: TileStore.fromPixels(pixels, width, height, 1), pixelsRevision: 0, assetId: null, enabled: true, linked: true, density: 1, feather: 0 };
}

/**
 * A layer mask that starts as the active pixel selection's shape — inside
 * the selection paints white (reveals), outside stays black (hides), the
 * same convention Photoshop uses for "Add Layer Mask" with a selection
 * active. `PixelSelection.mask` and `RasterLayerMask.tiles` are already
 * the identical shape (grayscale, one byte per document pixel) — `width`/
 * `height` are the document's, not `selection.bounds`'s (a selection's own
 * bounding box is smaller than the document whenever the selection doesn't
 * cover the whole canvas, but `selection.mask` itself is always
 * document-sized already, matching `RasterLayerMask`'s own invariant).
 */
export function createRasterLayerMaskFromSelection(selection: PixelSelection, width: number, height: number): RasterLayerMask {
  return { tiles: TileStore.fromPixels(selection.mask, width, height, 1), pixelsRevision: 0, assetId: null, enabled: true, linked: true, density: 1, feather: 0 };
}

export function defaultAdjustment(kind: RasterAdjustment["kind"]): RasterAdjustment {
  if (kind === "levels") return { kind, blackInput: 0, gamma: 1, whiteInput: 255, blackOutput: 0, whiteOutput: 255 };
  if (kind === "curves") return { kind, points: [{ x: 0, y: 0 }, { x: 255, y: 255 }] };
  if (kind === "hueSaturation") return { kind, hue: 0, saturation: 0, lightness: 0 };
  if (kind === "colorBalance") return { kind, cyanRed: 0, magentaGreen: 0, yellowBlue: 0 };
  if (kind === "brightnessContrast") return { kind, brightness: 0, contrast: 0 };
  if (kind === "exposure") return { kind, exposure: 0, offset: 0, gamma: 1 };
  if (kind === "vibrance") return { kind, vibrance: 0, saturation: 0 };
  if (kind === "blackWhite") return { kind, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: "#b18a65" };
  if (kind === "photoFilter") return { kind, color: "#f29900", density: 25, preserveLuminosity: true };
  if (kind === "channelMixer") return { kind, outputChannel: "red", red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], monochrome: false };
  if (kind === "gradientMap") return { kind, from: "#000000", to: "#ffffff", dither: false, reverse: false };
  if (kind === "selectiveColor") { const neutral = () => ({ cyan: 0, magenta: 0, yellow: 0, black: 0 }); return { kind, range: "reds", values: { reds: neutral(), yellows: neutral(), greens: neutral(), cyans: neutral(), blues: neutral(), magentas: neutral(), whites: neutral(), neutrals: neutral(), blacks: neutral() }, method: "relative" }; }
  if (kind === "shadowsHighlights") return { kind, shadows: 35, highlights: 0, colorCorrection: 20, midtoneContrast: 0, blackClip: .01, whiteClip: .01 };
  if (kind === "posterize") return { kind, levels: 4 };
  if (kind === "threshold") return { kind, threshold: 128 };
  if (kind === "colorLookup") return { kind, lut: builtInLuts[0]!, amount: 1 };
  return { kind: "invert" };
}

export function createAdjustmentLayer(width: number, height: number, kind: RasterAdjustment["kind"], name: string = kind): RasterLayer {
  return { ...createRasterLayer(width, height, name), kind: "adjustment", adjustment: defaultAdjustment(kind), mask: createRasterLayerMask(width, height) };
}

export function createRasterDocument(width = 1280, height = 720, options: RasterDocumentOptions = {}): RasterDocumentState {
  const layer = createRasterLayer(width, height, "Layer 1 (Слой 1)");
  if (options.backgroundColor) {
    const color = parseHexColor(options.backgroundColor);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < pixels.length; index += 4) { pixels[index] = color.r; pixels[index + 1] = color.g; pixels[index + 2] = color.b; pixels[index + 3] = color.a; }
    layer.tiles = TileStore.fromPixels(pixels, width, height);
  }
  return {
    kind: "raster", schemaVersion: 2, width, height, colorSpace: options.colorSpace ?? "srgb",
    resolution: options.resolution ?? 72, resolutionUnit: options.resolutionUnit ?? "ppi", bitDepth: options.bitDepth ?? 8,
    pixelAspectRatio: options.pixelAspectRatio ?? 1, backgroundColor: options.backgroundColor ?? null,
    layers: [layer], activeLayerId: layer.id, selection: null, guides: [],
  };
}

export function isRasterDocumentState(value: unknown): value is RasterDocumentState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RasterDocumentState>;
  if (candidate.kind !== "raster" || (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) || !Number.isInteger(candidate.width) || !Number.isInteger(candidate.height) || !Array.isArray(candidate.layers)) return false;
  migrateRasterDocumentState(candidate as RasterDocumentState);
  return true;
}

/** In-place and idempotent so restored v1 sessions remain editable without a stop-the-world conversion. */
export function migrateRasterDocumentState(state: RasterDocumentState): RasterDocumentState {
  state.layers.forEach((layer, index) => {
    if (typeof layer.parentId === "undefined") layer.parentId = null;
    if (!layer.orderKey) layer.orderKey = makeLayerOrderKey(index);
    if (typeof layer.clipping === "undefined") layer.clipping = false;
    // Documents written before layers had bounds stored a canvas-sized buffer.
    // Its bounds are the canvas, and it will be trimmed the next time it is
    // edited rather than rewritten here — a migration that rebuilt every buffer
    // would cost the whole image on open.
    if (!layer.bounds) {
      const width = layer.width || state.width, height = layer.height || state.height;
      layer.bounds = { x: 0, y: 0, width, height };
      layer.width = width;
      layer.height = height;
    }
    // Older saves predate pixelsRevision (docs/master-plan.md §37.6.2) — 0 is correct
    // regardless of how many edits actually produced the pixels on disk, since nothing
    // has read a revision number for this layer yet to compare against.
    if (typeof layer.pixelsRevision !== "number") layer.pixelsRevision = 0;
    // The layer analogue of the mask reconstruction below — same two cases, same reasoning
    // (docs/master-plan.md §37.6.3's step 4): a save from before the TileStore migration held a
    // flat `pixels` field directly; a save from after it, round-tripped through
    // document-snapshot-store.ts's JSON.stringify/JSON.parse, comes back as `TileStore.toJSON()`'s
    // plain {width, height, channels, pixels} shape, not a class instance. `layer.bounds` is
    // already settled by this point (just above), so its width/height are the right frame for a
    // layer's own bounds-local buffer — never `state.width`/`state.height`, which is a mask's
    // frame, not a layer's.
    {
      const rawLayer = layer as RasterLayer & { pixels?: Uint8ClampedArray };
      if (!(rawLayer.tiles instanceof TileStore)) {
        if (rawLayer.pixels) {
          rawLayer.tiles = TileStore.fromPixels(rawLayer.pixels, layer.bounds.width, layer.bounds.height);
          delete rawLayer.pixels;
        } else if (rawLayer.tiles) {
          rawLayer.tiles = TileStore.fromJSON(rawLayer.tiles as unknown as { width: number; height: number; channels: number; pixels: Uint8ClampedArray });
        }
      }
    }
    if (layer.mask) {
      const mask = layer.mask as RasterLayerMask & { pixels?: Uint8ClampedArray };
      if (!(mask.tiles instanceof TileStore)) {
        if (mask.pixels) {
          // A save from before §37.6.3: the mask was a flat Uint8ClampedArray field, and
          // document-snapshot-store.ts's existing typed-array handling already round-tripped
          // it correctly (it always has) — only the field it lived on has moved.
          mask.tiles = TileStore.fromPixels(mask.pixels, state.width, state.height, 1);
          delete mask.pixels;
        } else if (mask.tiles) {
          // A save from after §37.6.3, round-tripped through document-snapshot-store.ts's
          // JSON.stringify/JSON.parse: TileStore.toJSON()'s own doc comment names this exact
          // shape — a plain {width, height, channels, pixels} object, not a class instance,
          // because JSON.parse has no way to know it used to be one.
          mask.tiles = TileStore.fromJSON(mask.tiles as unknown as { width: number; height: number; channels: number; pixels: Uint8ClampedArray });
        }
      }
      if (mask.outside && !(mask.outside.tiles instanceof TileStore)) {
        mask.outside = { bounds: mask.outside.bounds, tiles: TileStore.fromJSON(mask.outside.tiles as unknown as { width: number; height: number; channels: number; pixels: Uint8ClampedArray }) };
      }
      if (typeof mask.pixelsRevision !== "number") mask.pixelsRevision = 0;
    }
    if (layer.kind === "group") {
      layer.expanded ??= true;
      layer.groupMode ??= "passThrough";
    }
  });
  state.schemaVersion = 2;
  return state;
}

export function activeRasterLayer(state: RasterDocumentState): RasterLayer {
  const layer = state.layers.find((item) => item.id === state.activeLayerId);
  if (!layer) throw new Error(`Active raster layer is missing: ${state.activeLayerId}`);
  return layer;
}

/**
 * A document snapshot cheap enough to take on every structural edit — the
 * `before`/`after` pair a whole-document history step commits.
 *
 * Shallow across the buffers that dominate a document's size (each layer's
 * `pixels`, a mask's `pixels`) so two snapshots taken moments apart share
 * memory rather than doubling it; deep only for the small mutable pieces a
 * structural edit (add/remove/replace a layer, rasterize, crop) actually
 * touches, so mutating one snapshot's layer object never bleeds into the
 * other's.
 */
export function cloneRasterState(state: RasterDocumentState): RasterDocumentState {
  return {
    ...state,
    layers: state.layers.map((layer) => ({
      ...layer,
      ...(layer.text ? { text: structuredClone(layer.text) } : {}),
      ...(layer.adjustment ? { adjustment: structuredClone(layer.adjustment) } : {}),
      ...(layer.mask ? { mask: { ...layer.mask } } : {}),
      ...(layer.smartSource ? { smartSource: { ...layer.smartSource } } : {}),
      ...(layer.smartTransform ? { smartTransform: { ...layer.smartTransform } } : {}),
    })),
    selection: state.selection ? { mask: state.selection.mask, bounds: { ...state.selection.bounds } } : null,
    guides: (state.guides ?? []).map((guide) => ({ ...guide })),
  };
}
