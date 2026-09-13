import type { AssetId } from "@vravio/kernel";
import type { RasterLayer, RasterRect, RasterSmartSource, RasterSmartTransform } from "./types";

const identityAt = (x: number, y: number): RasterSmartTransform => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

/** The placement of old sessions that pre-date `smartTransform` is identity. */
export function smartObjectTransform(layer: RasterLayer): RasterSmartTransform | null {
  return layer.kind === "smart" ? layer.smartTransform ?? identityAt(layer.bounds.x, layer.bounds.y) : null;
}

export function smartObjectBounds(layer: RasterLayer, transform = smartObjectTransform(layer)): RasterRect {
  if (!transform) return { ...layer.bounds };
  const points = [[0, 0], [layer.width, 0], [layer.width, layer.height], [0, layer.height]] as const;
  const xs = points.map(([x, y]) => transform.a * x + transform.c * y + transform.e);
  const ys = points.map(([x, y]) => transform.b * x + transform.d * y + transform.f);
  const left = Math.floor(Math.min(...xs)), top = Math.floor(Math.min(...ys));
  return { x: left, y: top, width: Math.max(1, Math.ceil(Math.max(...xs)) - left), height: Math.max(1, Math.ceil(Math.max(...ys)) - top) };
}

function multiply(left: RasterSmartTransform, right: RasterSmartTransform): RasterSmartTransform {
  return {
    a: left.a * right.a + left.c * right.b, b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d, d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e, f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function translateSmartObject(layer: RasterLayer, x: number, y: number): boolean {
  const current = smartObjectTransform(layer); if (!current) return false;
  layer.smartTransform = { ...current, e: current.e + x, f: current.f + y };
  layer.bounds = smartObjectBounds(layer, layer.smartTransform);
  return true;
}

/** Applies the same document-space transform described by the Move tool without sampling pixels. */
export function transformSmartObject(layer: RasterLayer, source: RasterRect, target: RasterRect, degrees: number): boolean {
  const current = smartObjectTransform(layer); if (!current || !source.width || !source.height) return false;
  const sx = target.width / source.width, sy = target.height / source.height;
  const radians = degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const cx = target.x + target.width / 2, cy = target.y + target.height / 2;
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  const delta: RasterSmartTransform = {
    a, b, c, d,
    e: cx + cos * (target.x - cx) - sin * (target.y - cy) - a * source.x - c * source.y,
    f: cy + sin * (target.x - cx) + cos * (target.y - cy) - b * source.x - d * source.y,
  };
  layer.smartTransform = multiply(delta, current);
  layer.bounds = smartObjectBounds(layer, layer.smartTransform);
  return true;
}

/** Replaces source contents while retaining the placed object's visible size. */
export function replaceSmartObjectSourcePixels(layer: RasterLayer, pixels: Uint8ClampedArray, width: number, height: number): boolean {
  const current = smartObjectTransform(layer); if (!current || width < 1 || height < 1 || pixels.length !== width * height * 4) return false;
  const oldWidth = Math.max(1, layer.width), oldHeight = Math.max(1, layer.height);
  layer.pixels = pixels; layer.width = width; layer.height = height;
  layer.smartTransform = { ...current, a: current.a * oldWidth / width, b: current.b * oldWidth / width, c: current.c * oldHeight / height, d: current.d * oldHeight / height };
  layer.bounds = smartObjectBounds(layer, layer.smartTransform);
  return true;
}

/** Pure Smart Object conversion; importing bytes remains the environment's job. */
export function convertLayerToEmbeddedSmartObject(layer: RasterLayer, assetId: AssetId): boolean {
  if (layer.kind !== "pixel" || !assetId) return false;
  layer.kind = "smart";
  layer.pixelAssetId = assetId;
  layer.smartSource = { assetId, pinnedRev: null, sourceKind: "raster", mode: "embedded" };
  layer.smartTransform = identityAt(layer.bounds.x, layer.bounds.y);
  return true;
}

/** Older sessions predate `mode`; their source is self-contained by default. */
export function smartObjectSourceMode(source: RasterSmartSource | undefined): "embedded" | "linked" | null {
  return source ? source.mode ?? "embedded" : null;
}

export function isEditableEmbeddedSmartObject(layer: RasterLayer): boolean {
  return layer.kind === "smart" && Boolean(layer.smartSource?.assetId) && smartObjectSourceMode(layer.smartSource) === "embedded";
}

/**
 * Rebinds a duplicated Smart Object to a separately imported asset. The caller
 * owns the byte copy and asset lifetime; this keeps the document mutation pure
 * and makes "New Smart Object via Copy" undoable as one structural step.
 */
export function makeIndependentEmbeddedSmartObjectCopy(layer: RasterLayer, assetId: AssetId): boolean {
  if (!isEditableEmbeddedSmartObject(layer) || !assetId) return false;
  layer.pixelAssetId = assetId;
  layer.smartSource = { ...layer.smartSource!, assetId, pinnedRev: null, mode: "embedded" };
  return true;
}
