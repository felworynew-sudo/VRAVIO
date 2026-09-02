import { createRasterGroup, createRasterLayer, makeLayerOrderKey } from "./document";
import { appendLayer, flattenRasterLayers, isLayerEffectivelyVisible, rasterLayerDescendantIds } from "./layer-tree";
import { compositeRasterRegion } from "./render";
import type { PixelSelection, RasterDocumentState, RasterLayer } from "./types";

const siblingsOf = (state: RasterDocumentState, parentId: string | null): RasterLayer[] =>
  state.layers.filter((layer) => layer.parentId === parentId).sort((a, b) => a.orderKey.localeCompare(b.orderKey));

/** Rewrites a run of siblings into evenly spaced order keys. */
function reorderSiblings(ordered: readonly RasterLayer[]): void {
  ordered.forEach((layer, index) => { layer.orderKey = makeLayerOrderKey(index); });
}

const find = (state: RasterDocumentState, id: string): RasterLayer | undefined => state.layers.find((layer) => layer.id === id);

/**
 * Copies a layer, its mask and its style, and puts the copy directly above it.
 *
 * Photoshop's Duplicate Layer. The pixels are copied rather than shared: the
 * two layers are independent from the moment they exist, and a snapshot taken
 * later would otherwise see one buffer standing for both.
 */
export function duplicateLayer(state: RasterDocumentState, layerId: string): RasterLayer | null {
  const source = find(state, layerId);
  if (!source) return null;

  const copies = new Map<string, RasterLayer>();
  const copyOne = (layer: RasterLayer, parentId: string | null): RasterLayer => {
    const copy: RasterLayer = {
      ...layer,
      id: crypto.randomUUID(),
      parentId,
      pixels: layer.pixels.slice(),
      ...(layer.mask ? { mask: { ...layer.mask, pixels: layer.mask.pixels.slice(), assetId: null } } : {}),
      ...(layer.text ? { text: structuredClone(layer.text) } : {}),
      ...(layer.adjustment ? { adjustment: structuredClone(layer.adjustment) } : {}),
      effects: structuredClone(layer.effects ?? {}),
    };
    // A copy is a new buffer, so it must not claim the original's asset.
    delete copy.pixelAssetId;
    delete copy.maskAssetId;
    state.layers.push(copy);
    copies.set(layer.id, copy);
    if (layer.kind === "group") for (const child of siblingsOf(state, layer.id)) copyOne(child, copy.id);
    return copy;
  };

  const copy = copyOne(source, source.parentId ?? null);
  copy.name = `${source.name} copy (копия)`;

  const peers = siblingsOf(state, source.parentId ?? null).filter((layer) => layer.id !== copy.id);
  const at = peers.findIndex((layer) => layer.id === source.id);
  reorderSiblings([...peers.slice(0, at + 1), copy, ...peers.slice(at + 1)]);
  state.activeLayerId = copy.id;
  return copy;
}

/**
 * Merges a layer into the one below it, as Cmd/Ctrl+E does.
 *
 * The result keeps the lower layer's identity, because that is what everything
 * pointing at it — a clipping mask above, a round-trip session — expects to
 * still be there afterwards.
 */
export function mergeLayerDown(state: RasterDocumentState, layerId: string): RasterLayer | null {
  const upper = find(state, layerId);
  if (!upper || upper.kind === "group") return null;
  const peers = siblingsOf(state, upper.parentId ?? null);
  const at = peers.findIndex((layer) => layer.id === upper.id);
  const lower = peers[at - 1];
  if (!lower || lower.kind === "group") return null;

  // Compositing the pair on their own gives the same result the canvas shows,
  // including blend mode and opacity, which hand-blending the two buffers would
  // have to reimplement and get wrong.
  const pair: RasterDocumentState = {
    ...state,
    layers: [{ ...lower, parentId: null, clipping: false, orderKey: makeLayerOrderKey(0) }, { ...upper, parentId: null, orderKey: makeLayerOrderKey(1) }],
  };
  const merged = compositeRasterRegion(pair, { x: 0, y: 0, width: state.width, height: state.height });

  lower.pixels = merged;
  lower.kind = "pixel";
  lower.opacity = 1;
  lower.fillOpacity = 1;
  lower.blendMode = "normal";
  lower.effects = {};
  delete lower.text;
  delete lower.adjustment;
  delete lower.mask;
  delete lower.pixelAssetId;
  delete lower.maskAssetId;

  const removed = new Set([upper.id, ...rasterLayerDescendantIds(state.layers, upper.id)]);
  state.layers = state.layers.filter((layer) => !removed.has(layer.id));
  state.activeLayerId = lower.id;
  return lower;
}

/** Flattens every visible layer into one, leaving hidden layers alone (Cmd/Ctrl+Shift+E). */
export function mergeVisibleLayers(state: RasterDocumentState): RasterLayer | null {
  const visible = flattenRasterLayers(state.layers).filter((layer) => layer.kind !== "group" && isLayerEffectivelyVisible(layer, state.layers));
  if (visible.length < 2) return null;

  const merged = compositeRasterRegion(state, { x: 0, y: 0, width: state.width, height: state.height });
  const lowest = visible[0]!;
  const removed = new Set(visible.slice(1).flatMap((layer) => [layer.id, ...rasterLayerDescendantIds(state.layers, layer.id)]));

  lowest.pixels = merged;
  lowest.kind = "pixel";
  lowest.opacity = 1;
  lowest.fillOpacity = 1;
  lowest.blendMode = "normal";
  lowest.effects = {};
  lowest.clipping = false;
  delete lowest.text;
  delete lowest.adjustment;
  delete lowest.mask;
  delete lowest.pixelAssetId;
  delete lowest.maskAssetId;

  state.layers = state.layers.filter((layer) => !removed.has(layer.id));
  // Groups whose contents all merged away have nothing left to hold.
  state.layers = state.layers.filter((layer) => layer.kind !== "group" || state.layers.some((child) => child.parentId === layer.id));
  state.activeLayerId = lowest.id;
  return lowest;
}

/**
 * Composites everything visible into a new layer on top, leaving the originals.
 *
 * Photoshop's Stamp Visible, Cmd/Ctrl+Alt/Option+Shift+E — the move that lets
 * you keep working on a flattened copy without losing what it came from.
 */
export function stampVisibleLayers(state: RasterDocumentState): RasterLayer | null {
  const anyVisible = flattenRasterLayers(state.layers).some((layer) => layer.kind !== "group" && isLayerEffectivelyVisible(layer, state.layers));
  if (!anyVisible) return null;
  const stamp = createRasterLayer(state.width, state.height, "Merged (Объединённое)");
  stamp.pixels = compositeRasterRegion(state, { x: 0, y: 0, width: state.width, height: state.height });
  appendLayer(state, stamp);
  state.activeLayerId = stamp.id;
  return stamp;
}

/** Puts the given layers into a new group in their place (Cmd/Ctrl+G). */
export function groupLayers(state: RasterDocumentState, layerIds: readonly string[], name = "Group (Группа)"): RasterLayer | null {
  const members = layerIds.map((id) => find(state, id)).filter((layer): layer is RasterLayer => Boolean(layer));
  if (members.length === 0) return null;
  // Grouping across branches has no single place to put the group; Photoshop
  // groups what shares a parent, so the topmost member's parent wins.
  const parentId = members[members.length - 1]!.parentId ?? null;
  const chosen = members.filter((layer) => (layer.parentId ?? null) === parentId);
  if (chosen.length === 0) return null;

  const group = createRasterGroup(state.width, state.height, name);
  group.parentId = parentId;
  state.layers.push(group);

  const peers = siblingsOf(state, parentId).filter((layer) => layer.id !== group.id && !chosen.some((member) => member.id === layer.id));
  const highest = siblingsOf(state, parentId).findIndex((layer) => layer.id === chosen[chosen.length - 1]!.id);
  const before = peers.filter((layer) => siblingsOf(state, parentId).indexOf(layer) < highest);
  reorderSiblings([...before, group, ...peers.filter((layer) => !before.includes(layer))]);

  const ordered = chosen.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  for (const member of ordered) member.parentId = group.id;
  reorderSiblings(ordered);

  state.activeLayerId = group.id;
  return group;
}

/** Dissolves a group, leaving its contents where they were (Cmd/Ctrl+Shift+G). */
export function ungroupLayer(state: RasterDocumentState, groupId: string): boolean {
  const group = find(state, groupId);
  if (!group || group.kind !== "group") return false;
  const children = siblingsOf(state, group.id);
  const parentId = group.parentId ?? null;
  const peers = siblingsOf(state, parentId);
  const at = peers.findIndex((layer) => layer.id === group.id);

  for (const child of children) child.parentId = parentId;
  reorderSiblings([...peers.slice(0, at), ...children, ...peers.slice(at + 1)]);
  state.layers = state.layers.filter((layer) => layer.id !== group.id);
  state.activeLayerId = children[children.length - 1]?.id ?? state.activeLayerId;
  return true;
}

export type LayerMove = "up" | "down" | "top" | "bottom";

/**
 * Moves a layer within its group.
 *
 * Cmd/Ctrl+[ and ] step, with Shift going all the way. Photoshop keeps the
 * layer inside whatever group it is in rather than letting it escape at the
 * ends, which is what makes repeated presses safe to hold down.
 */
export function moveLayerInStack(state: RasterDocumentState, layerId: string, move: LayerMove): boolean {
  const layer = find(state, layerId);
  if (!layer) return false;
  const peers = siblingsOf(state, layer.parentId ?? null);
  const at = peers.findIndex((item) => item.id === layerId);
  if (at < 0) return false;

  const target = move === "up" ? at + 1 : move === "down" ? at - 1 : move === "top" ? peers.length - 1 : 0;
  if (target === at || target < 0 || target >= peers.length) return false;

  const rest = peers.filter((item) => item.id !== layerId);
  reorderSiblings([...rest.slice(0, target), layer, ...rest.slice(target)]);
  return true;
}

/** Drops a layer at an explicit position, for a drag in the panel. */
export function placeLayer(state: RasterDocumentState, layerId: string, parentId: string | null, index: number): boolean {
  const layer = find(state, layerId);
  if (!layer) return false;
  // A group cannot be dropped inside itself, or the tree stops being a tree.
  if (parentId && (parentId === layerId || rasterLayerDescendantIds(state.layers, layerId).includes(parentId))) return false;

  // `index` names a place in the list as it stands, with the dragged layer still
  // in it. Taking the layer out first shifts everything above it down by one, so
  // a drag upward would land a place short without this.
  const before = siblingsOf(state, parentId);
  const wasAt = before.findIndex((item) => item.id === layerId);
  const peers = before.filter((item) => item.id !== layerId);
  const shifted = wasAt >= 0 && wasAt < index ? index - 1 : index;
  const at = Math.max(0, Math.min(shifted, peers.length));

  layer.parentId = parentId;
  reorderSiblings([...peers.slice(0, at), layer, ...peers.slice(at)]);
  return true;
}

/**
 * Lifts the selected pixels onto a new layer above (Cmd/Ctrl+J).
 *
 * With no selection this duplicates the layer, which is what Photoshop does.
 * `cut` clears the pixels it took from the source, giving Layer via Cut.
 */
export function layerFromSelection(
  state: RasterDocumentState, layerId: string, selection: PixelSelection | null, cut = false,
): RasterLayer | null {
  const source = find(state, layerId);
  if (!source || source.kind === "group") return null;
  if (!selection) return cut ? null : duplicateLayer(state, layerId);

  const lifted = createRasterLayer(state.width, state.height, cut ? "Layer via Cut (Слой вырезанием)" : "Layer via Copy (Слой копированием)");
  const taken = cut ? source.pixels.slice() : null;
  for (let index = 0; index < selection.mask.length; index += 1) {
    const coverage = selection.mask[index]! / 255;
    if (coverage <= 0) continue;
    const at = index * 4;
    lifted.pixels[at] = source.pixels[at]!;
    lifted.pixels[at + 1] = source.pixels[at + 1]!;
    lifted.pixels[at + 2] = source.pixels[at + 2]!;
    lifted.pixels[at + 3] = Math.round(source.pixels[at + 3]! * coverage);
    // A partially selected pixel is shared: what the copy takes is what the
    // original loses, so a feathered edge stays continuous across the two.
    if (taken) taken[at + 3] = Math.round(source.pixels[at + 3]! * (1 - coverage));
  }
  if (taken) source.pixels = taken;

  lifted.parentId = source.parentId ?? null;
  state.layers.push(lifted);
  const peers = siblingsOf(state, lifted.parentId).filter((layer) => layer.id !== lifted.id);
  const at = peers.findIndex((layer) => layer.id === source.id);
  reorderSiblings([...peers.slice(0, at + 1), lifted, ...peers.slice(at + 1)]);
  state.activeLayerId = lifted.id;
  return lifted;
}

export interface DropTarget {
  readonly parentId: string | null;
  readonly index: number;
}

/**
 * Where a row dropped on another row should land.
 *
 * The panel lists layers topmost first while the tree stores them bottom-up, so
 * "above" in the panel is a higher index in the parent. `position` is where the
 * pointer sits over the target row: its top third inserts above, its bottom
 * third below, and the middle of a group row drops inside it — which is the only
 * way to put something into a collapsed group by dragging.
 */
export function dropTargetForRow(
  state: RasterDocumentState, overId: string, position: "above" | "into" | "below",
): DropTarget | null {
  const over = state.layers.find((layer) => layer.id === overId);
  if (!over) return null;
  if (position === "into") {
    if (over.kind !== "group") return null;
    return { parentId: over.id, index: state.layers.filter((layer) => layer.parentId === over.id).length };
  }
  const parentId = over.parentId ?? null;
  const peers = state.layers
    .filter((layer) => layer.parentId === parentId)
    .sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  const at = peers.findIndex((layer) => layer.id === overId);
  if (at < 0) return null;
  return { parentId, index: position === "above" ? at + 1 : at };
}

/** Which third of a row the pointer is in, for {@link dropTargetForRow}. */
export function dropPositionInRow(offsetY: number, height: number, isGroup: boolean): "above" | "into" | "below" {
  if (height <= 0) return "above";
  const ratio = Math.max(0, Math.min(1, offsetY / height));
  if (isGroup) return ratio < 0.3 ? "above" : ratio > 0.7 ? "below" : "into";
  return ratio < 0.5 ? "above" : "below";
}
