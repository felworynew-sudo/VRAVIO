import { createRasterGroup, makeLayerOrderKey } from "./document";
import type { RasterDocumentState, RasterLayer } from "./types";

export interface RasterLayerRow { layer: RasterLayer; depth: number }

const siblings = (layers: RasterLayer[], parentId: string | null): RasterLayer[] => layers
  .filter((layer) => layer.parentId === parentId)
  .sort((a, b) => a.orderKey.localeCompare(b.orderKey));

/** Bottom-to-top paint order, with children contained by their group. */
export function flattenRasterLayers(layers: RasterLayer[], parentId: string | null = null): RasterLayer[] {
  return siblings(layers, parentId).flatMap((layer) => layer.kind === "group" ? [layer, ...flattenRasterLayers(layers, layer.id)] : [layer]);
}

/** Photoshop panel order (topmost first), excluding descendants of collapsed groups. */
export function rasterLayerRows(layers: RasterLayer[]): RasterLayerRow[] {
  const visit = (parentId: string | null, depth: number): RasterLayerRow[] => siblings(layers, parentId).reverse().flatMap((layer) => [
    { layer, depth },
    ...(layer.kind === "group" && layer.expanded !== false ? visit(layer.id, depth + 1) : []),
  ]);
  return visit(null, 0);
}

export function appendLayer(state: RasterDocumentState, layer: RasterLayer, parentId: string | null = null): RasterLayer {
  const peers = state.layers.filter((item) => item.parentId === parentId);
  layer.parentId = parentId;
  const nextOrder = peers.reduce((maximum, peer) => Math.max(maximum, Number.parseInt(peer.orderKey, 36) || 0), -1) + 1;
  layer.orderKey = makeLayerOrderKey(nextOrder);
  state.layers.push(layer);
  return layer;
}

export function appendRasterGroup(state: RasterDocumentState, name = "Group (Группа)"): RasterLayer {
  return appendLayer(state, createRasterGroup(state.width, state.height, name));
}

export function rasterLayerDescendantIds(layers: RasterLayer[], parentId: string): string[] {
  return siblings(layers, parentId).flatMap((layer) => [layer.id, ...rasterLayerDescendantIds(layers, layer.id)]);
}

export function isLayerEffectivelyVisible(layer: RasterLayer, layers: RasterLayer[]): boolean {
  let current: RasterLayer | undefined = layer;
  const seen = new Set<string>();
  while (current) {
    if (!current.visible || seen.has(current.id)) return false;
    seen.add(current.id);
    current = current.parentId ? layers.find((candidate) => candidate.id === current!.parentId) : undefined;
  }
  return true;
}

export function effectiveLayerOpacity(layer: RasterLayer, layers: RasterLayer[]): number {
  let opacity = layer.opacity;
  let parent = layer.parentId ? layers.find((candidate) => candidate.id === layer.parentId) : undefined;
  const seen = new Set<string>();
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    opacity *= parent.opacity;
    parent = parent.parentId ? layers.find((candidate) => candidate.id === parent!.parentId) : undefined;
  }
  return opacity;
}
