import { builtInLuts } from "./lut";
import { parseHexColor } from "./color";
import type { RasterAdjustment, RasterDocumentOptions, RasterDocumentState, RasterLayer, RasterLayerMask } from "./types";

export const makeLayerOrderKey = (index: number): string => Math.max(0, Math.floor(index)).toString(36).padStart(8, "0");

export function createRasterLayer(width: number, height: number, name = "Layer (Слой)"): RasterLayer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError("Raster layer dimensions must be positive integers");
  // Created at canvas size: a tool needs somewhere to paint before it knows
  // where the paint will land. What gets stored is trimmed when the edit is
  // committed, which is where the size actually matters.
  return { id: crypto.randomUUID(), name, bounds: { x: 0, y: 0, width, height }, width, height, pixels: new Uint8ClampedArray(width * height * 4), visible: true, opacity: 1, fillOpacity: 1, blendMode: "normal", locked: false, kind: "pixel", effects: {}, parentId: null, orderKey: makeLayerOrderKey(0), clipping: false };
}

export function createRasterGroup(width: number, height: number, name = "Group (Группа)"): RasterLayer {
  return { ...createRasterLayer(width, height, name), kind: "group", expanded: true, groupMode: "passThrough" };
}

export function createRasterLayerMask(width: number, height: number, reveal = true): RasterLayerMask {
  const pixels = new Uint8ClampedArray(width * height);
  if (reveal) pixels.fill(255);
  return { pixels, assetId: null, enabled: true, inverted: false, linked: true, density: 1, feather: 0 };
}

export function defaultAdjustment(kind: RasterAdjustment["kind"]): RasterAdjustment {
  if (kind === "levels") return { kind, blackInput: 0, gamma: 1, whiteInput: 255, blackOutput: 0, whiteOutput: 255 };
  if (kind === "curves") return { kind, points: [{ x: 0, y: 0 }, { x: 255, y: 255 }] };
  if (kind === "hueSaturation") return { kind, hue: 0, saturation: 0, lightness: 0 };
  if (kind === "colorBalance") return { kind, cyanRed: 0, magentaGreen: 0, yellowBlue: 0 };
  if (kind === "brightnessContrast") return { kind, brightness: 0, contrast: 0 };
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
    for (let index = 0; index < layer.pixels.length; index += 4) { layer.pixels[index] = color.r; layer.pixels[index + 1] = color.g; layer.pixels[index + 2] = color.b; layer.pixels[index + 3] = color.a; }
  }
  return {
    kind: "raster", schemaVersion: 2, width, height, colorSpace: "srgb",
    resolution: options.resolution ?? 72, resolutionUnit: options.resolutionUnit ?? "ppi", bitDepth: 8,
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
