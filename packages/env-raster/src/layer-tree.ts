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
/** A layer's own coverage at one pixel — alpha × its mask × its (inherited) opacity × fill
 * opacity — the same formula `pickLayerAt` already used before it also had to ask "but is this
 * layer even showing here, once clipping is accounted for". Factored out so both a clipped
 * layer and the base it clips to are judged by the identical rule. */
function ownCoverageAt(layer: RasterLayer, layers: RasterLayer[], column: number, row: number, index: number): number {
  const mask = layer.mask?.enabled ? layer.mask : null;
  const maskAlpha = mask ? (mask.pixels[index]! / 255) * mask.density : 1;
  return (layerAlphaAt(layer, column, row) / 255) * maskAlpha * effectiveLayerOpacity(layer, layers) * (layer.fillOpacity ?? 1);
}

export function pickLayerAt(
  state: RasterDocumentState, x: number, y: number, options: PickLayerOptions = {},
): RasterLayer | null {
  const column = Math.floor(x), row = Math.floor(y);
  if (column < 0 || row < 0 || column >= state.width || row >= state.height) return null;
  const threshold = options.threshold ?? 0.5;
  const index = row * state.width + column;
  // Bottom-to-top paint order — a clipped layer's base is the nearest earlier (lower) entry
  // here sharing its parent, the same relationship `render.ts`'s own compositor walks to build
  // its `clippingBaseByParent` accumulator; computed once per pick rather than per candidate
  // layer, since more than one clipped layer here can share the same base.
  const flat = flattenRasterLayers(state.layers);

  for (let flatIndex = flat.length - 1; flatIndex >= 0; flatIndex -= 1) {
    const layer = flat[flatIndex]!;
    if (layer.kind === "group" || layer.kind === "adjustment" || layer.adjustment) continue;
    if (!isLayerEffectivelyVisible(layer, state.layers)) continue;

    let coverage = ownCoverageAt(layer, state.layers, column, row, index);
    // A clipping layer only actually shows where its base is opaque too (`render.ts`'s own
    // `clippingBase`/`baseAlpha` for the real compositor) — a click inside the clipped layer's
    // own bounds/mask, but outside where the base shows through, must fall through to whatever
    // is genuinely visible there instead of picking a layer the canvas doesn't actually draw at
    // that pixel. Found live: clicking a clipping-masked layer's fully-opaque own area still
    // picked it even where the clip base beneath it was transparent, selecting a layer the user
    // could not actually see.
    if (layer.clipping && coverage > 0) {
      let base: RasterLayer | undefined;
      for (let baseIndex = flatIndex - 1; baseIndex >= 0; baseIndex -= 1) {
        const candidate = flat[baseIndex]!;
        if (candidate.parentId !== layer.parentId) continue;
        if (candidate.clipping) continue; // clip bases are never themselves clipped
        base = candidate;
        break;
      }
      coverage = base ? Math.min(coverage, ownCoverageAt(base, state.layers, column, row, index)) : 0;
    }
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
