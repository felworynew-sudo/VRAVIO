import { createRasterGroup, makeLayerOrderKey } from "./document";
import { layerAlphaAt } from "./layer-bounds";
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

export interface PickLayerOptions {
  /**
   * Coverage a layer needs at the point to be picked, 0..1.
   *
   * Antialiased edges fade out over a pixel or two, and picking at the first
   * hint of alpha means a click near an outline grabs the shape rather than
   * what is visible behind it. Half opacity is where Photoshop draws the line.
   */
  readonly threshold?: number;
  /** "group" returns the outermost group the hit layer sits in, as Photoshop's Auto-Select does. */
  readonly target?: "layer" | "group";
}

/**
 * The layer a click at this point should select.
 *
 * This is what the Move tool's Auto-Select does: the topmost thing actually
 * visible under the pointer, rather than whatever happened to be selected in
 * the panel. Groups and adjustment layers are never the answer for a "layer"
 * pick — a group has no pixels of its own, and an adjustment covers the whole
 * canvas, so picking it would make everything under it unreachable.
 */
export function pickLayerAt(
  state: RasterDocumentState, x: number, y: number, options: PickLayerOptions = {},
): RasterLayer | null {
  const column = Math.floor(x), row = Math.floor(y);
  if (column < 0 || row < 0 || column >= state.width || row >= state.height) return null;
  const threshold = options.threshold ?? 0.5;
  const index = row * state.width + column;

  for (const layer of [...flattenRasterLayers(state.layers)].reverse()) {
    if (layer.kind === "group" || layer.kind === "adjustment" || layer.adjustment) continue;
    if (!isLayerEffectivelyVisible(layer, state.layers)) continue;

    const mask = layer.mask?.enabled ? layer.mask : null;
    const maskAlpha = mask ? ((mask.inverted ? 255 - mask.pixels[index]! : mask.pixels[index]!) / 255) * mask.density : 1;
    // Read where the layer actually lives; its buffer is sized to its bounds.
    const coverage = (layerAlphaAt(layer, column, row) / 255) * maskAlpha * effectiveLayerOpacity(layer, state.layers) * (layer.fillOpacity ?? 1);
    if (coverage < threshold) continue;

    if (options.target !== "group") return layer;
    // Auto-Select: Group moves the whole group as a unit, so the answer is the
    // outermost group the hit layer belongs to, not its immediate parent.
    let outermost: RasterLayer | null = null;
    for (let parentId = layer.parentId; parentId; ) {
      const parent: RasterLayer | undefined = state.layers.find((item) => item.id === parentId);
      if (!parent) break;
      outermost = parent;
      parentId = parent.parentId;
    }
    return outermost ?? layer;
  }
  return null;
}
