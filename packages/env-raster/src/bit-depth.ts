import { isRasterBitDepth, type RasterBitDepth } from "./pixel-format";
import type { RasterDocumentState, RasterLayer } from "./types";

/**
 * Changing a document's bits per channel — Photoshop's Image ▸ Mode ▸ 8/16/32 Bits/Channel
 * (docs/master-plan.md §59.2).
 *
 * What actually changes is where the pixels live: every pixel layer's `TileStore` is rebuilt at the
 * new depth (`TileStore.withDepth`), and the document records what it is in. Going up is exact and
 * costs memory (16-bit doubles it, 32-bit quadruples it); going down rounds and clips, and is the
 * only lossy direction — which is why the command that calls this keeps the old stores for undo.
 *
 * Masks stay 8-bit at every depth, deliberately. A mask is coverage, not colour: Photoshop's own
 * masks are 8-bit in a 16-bit document too, and widening them would double the cost of every mask
 * in the file to buy precision nothing in the compositor can currently use.
 *
 * Adjustment and text layers hold no pixels of their own worth converting — they are re-rendered
 * from their parameters — but their cached `tiles` go along anyway so that nothing downstream ever
 * meets a layer whose storage disagrees with its document.
 */
export function layerAtDepth(layer: RasterLayer, depth: RasterBitDepth): RasterLayer {
  if (!layer.tiles || layer.tiles.depth === depth) return layer;
  return { ...layer, tiles: layer.tiles.withDepth(depth), pixelsRevision: layer.pixelsRevision + 1 };
}

/** Every layer of `state` at `depth`, as a new layer array — the state itself is left alone so the
 *  caller can put the result into history the way it puts every other pixel change. */
export function documentLayersAtDepth(state: RasterDocumentState, depth: RasterBitDepth): RasterLayer[] {
  return state.layers.map((layer) => layerAtDepth(layer, depth));
}

/** What a document costs in memory at a given depth, for the dialog that has to say so out loud. */
export function documentPixelBytes(width: number, height: number, depth: RasterBitDepth): number {
  return width * height * 4 * (depth === 8 ? 1 : depth === 16 ? 2 : 4);
}

/** The depth a document is really stored in, which is the depth its pixel layers are in — not the
 *  `bitDepth` field, which is what it *says* it is. The two can only disagree in a save written
 *  before §59.2, and this is what tells the difference. */
export function actualDocumentDepth(state: RasterDocumentState): RasterBitDepth {
  for (const layer of state.layers) {
    if (layer.kind === "pixel" && layer.tiles) return layer.tiles.depth;
  }
  return isRasterBitDepth(state.bitDepth) ? state.bitDepth : 8;
}
