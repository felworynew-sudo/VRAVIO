import { parseHexColor } from "./color";
import type { RasterAdjustment, RasterDocumentOptions, RasterDocumentState, RasterLayer } from "./types";

export function createRasterLayer(width: number, height: number, name = "Layer (Слой)"): RasterLayer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError("Raster layer dimensions must be positive integers");
  return { id: crypto.randomUUID(), name, width, height, pixels: new Uint8ClampedArray(width * height * 4), visible: true, opacity: 1, fillOpacity: 1, blendMode: "normal", locked: false, kind: "pixel", effects: {} };
}

export function defaultAdjustment(kind: RasterAdjustment["kind"]): RasterAdjustment {
  if (kind === "levels") return { kind, blackInput: 0, gamma: 1, whiteInput: 255, blackOutput: 0, whiteOutput: 255 };
  if (kind === "curves") return { kind, points: [{ x: 0, y: 0 }, { x: 255, y: 255 }] };
  if (kind === "hueSaturation") return { kind, hue: 0, saturation: 0, lightness: 0 };
  if (kind === "colorBalance") return { kind, cyanRed: 0, magentaGreen: 0, yellowBlue: 0 };
  if (kind === "brightnessContrast") return { kind, brightness: 0, contrast: 0 };
  if (kind === "posterize") return { kind, levels: 4 };
  if (kind === "threshold") return { kind, threshold: 128 };
  return { kind: "invert" };
}

export function createAdjustmentLayer(width: number, height: number, kind: RasterAdjustment["kind"], name: string = kind): RasterLayer {
  return { ...createRasterLayer(width, height, name), kind: "adjustment", adjustment: defaultAdjustment(kind) };
}

export function createRasterDocument(width = 1280, height = 720, options: RasterDocumentOptions = {}): RasterDocumentState {
  const layer = createRasterLayer(width, height, "Layer 1 (Слой 1)");
  if (options.backgroundColor) {
    const color = parseHexColor(options.backgroundColor);
    for (let index = 0; index < layer.pixels.length; index += 4) { layer.pixels[index] = color.r; layer.pixels[index + 1] = color.g; layer.pixels[index + 2] = color.b; layer.pixels[index + 3] = color.a; }
  }
  return {
    kind: "raster", schemaVersion: 1, width, height, colorSpace: "srgb",
    resolution: options.resolution ?? 72, resolutionUnit: options.resolutionUnit ?? "ppi", bitDepth: 8,
    pixelAspectRatio: options.pixelAspectRatio ?? 1, backgroundColor: options.backgroundColor ?? null,
    layers: [layer], activeLayerId: layer.id, selection: null, guides: [],
  };
}

export function isRasterDocumentState(value: unknown): value is RasterDocumentState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RasterDocumentState>;
  return candidate.kind === "raster" && candidate.schemaVersion === 1 && Number.isInteger(candidate.width) && Number.isInteger(candidate.height) && Array.isArray(candidate.layers);
}

export function activeRasterLayer(state: RasterDocumentState): RasterLayer {
  const layer = state.layers.find((item) => item.id === state.activeLayerId);
  if (!layer) throw new Error(`Active raster layer is missing: ${state.activeLayerId}`);
  return layer;
}
