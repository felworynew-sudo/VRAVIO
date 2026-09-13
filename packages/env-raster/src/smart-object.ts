import type { AssetId } from "@vravio/kernel";
import type { RasterLayer, RasterSmartSource } from "./types";

/** Pure Smart Object conversion; importing bytes remains the environment's job. */
export function convertLayerToEmbeddedSmartObject(layer: RasterLayer, assetId: AssetId): boolean {
  if (layer.kind !== "pixel" || !assetId) return false;
  layer.kind = "smart";
  layer.pixelAssetId = assetId;
  layer.smartSource = { assetId, pinnedRev: null, sourceKind: "raster", mode: "embedded" };
  return true;
}

/** Older sessions predate `mode`; their source is self-contained by default. */
export function smartObjectSourceMode(source: RasterSmartSource | undefined): "embedded" | "linked" | null {
  return source ? source.mode ?? "embedded" : null;
}

export function isEditableEmbeddedSmartObject(layer: RasterLayer): boolean {
  return layer.kind === "smart" && Boolean(layer.smartSource?.assetId) && smartObjectSourceMode(layer.smartSource) === "embedded";
}
