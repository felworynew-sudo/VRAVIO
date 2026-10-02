import { adjustLayerPixelsDeep, applyAdjustment, confineToSelection, isRasterDocumentState, layerDocumentPixels, setLayerPixels, TileStore, type PixelSelection, type RasterAdjustment, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "../kernel";
import { maskToRgba, rgbaToMask } from "../raster-pixel-buffers";
import { rasterAdjustmentById } from "./registry";

/** Computes a destructive adjustment without mutating its source. */
export function adjustedPixels(source: Uint8ClampedArray, adjustment: RasterAdjustment, selection: PixelSelection | null): Uint8ClampedArray {
  const result = source.slice();
  applyAdjustment(result, adjustment);
  return selection ? confineToSelection(source, result, selection.mask) : result;
}

/**
 * Writes an adjustment into a layer's own pixels, as one undo step.
 *
 * The one door for *destructive* adjustment, used both by the Image ▸
 * Adjustments dialogs (on OK) and by the adjustments that have no dialog at
 * all — Photoshop's Desaturate (Shift+Ctrl+U) being the first of those. It
 * lived inside `App.tsx`'s `applyImageAdjustment` until the second caller
 * appeared; a copy of it next to the first would have been three paths to
 * forget separately (CLAUDE.md §4), because the interesting part is not the
 * arithmetic but *which buffer* is rewritten:
 *
 *   - a layer mask is single-channel grey, so it goes through `maskToRgba` /
 *     `rgbaToMask` to meet the same RGBA adjustment math;
 *   - a 16/32-bit layer is adjusted in its own depth and its own frame
 *     (master-plan §59.2a), because the canvas-sized 8-bit buffer the plain
 *     path materialises is the narrow part there;
 *   - an 8-bit layer goes through `setLayerPixels`, the only function that
 *     keeps `bounds` and the buffer consistent (CLAUDE.md §2).
 *
 * Returns false when there was nothing to adjust — no document, no such
 * layer, or a layer kind that has no pixels of its own.
 */
export function applyAdjustmentToLayer(documentId: string, layerId: string, adjustment: RasterAdjustment, options: { readonly targetsMask?: boolean } = {}): boolean {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return false;
  const target = document.state.layers.find((layer) => layer.id === layerId);
  if (!target) return false;
  const definition = rasterAdjustmentById.get(adjustment.kind), history = kernel.historyByDocument.get(document.id);
  const name = definition?.name.en ?? adjustment.kind;

  if (options.targetsMask) {
    if (!target.mask) return false;
    const before = maskToRgba(target.mask.tiles.toPixels()), confined = adjustedPixels(before, adjustment, document.state.selection);
    const beforeMask = target.mask.tiles.toPixels(), afterMask = rgbaToMask(confined);
    const assignMask = (pixels: Uint8ClampedArray) => { kernel.documents.update<RasterDocumentState>(document.id, (state) => { const layer = state.layers.find((item) => item.id === target.id); if (layer?.mask) { layer.mask.tiles = TileStore.fromPixels(pixels, state.width, state.height, 1); layer.mask.pixelsRevision += 1; } }); };
    if (history) void history.execute({ label: `Mask Adjustment: ${name}`, memoryEstimate: beforeMask.byteLength + afterMask.byteLength, redo: () => assignMask(afterMask), undo: () => assignMask(beforeMask) }); else assignMask(afterMask);
    return true;
  }

  if (target.kind !== "pixel") return false;

  // Undo keeps the previous tiles, since the adjustment is not reversible by re-running it.
  if ((target.tiles?.depth ?? 8) !== 8) {
    const deep = adjustLayerPixelsDeep(target, adjustment, document.state.selection, document.state.width, document.state.height);
    if (deep) {
      const assignDeep = (pixels: typeof deep.before) => { kernel.documents.update<RasterDocumentState>(document.id, (state) => { const layer = state.layers.find((item) => item.id === target.id); if (layer?.tiles) { const tiles = layer.tiles.clone(); tiles.writeLocalRegion(deep.rect, pixels); layer.tiles = tiles; layer.pixelsRevision += 1; } }); };
      if (history) void history.execute({ label: `Adjustment: ${name}`, memoryEstimate: deep.before.byteLength + deep.after.byteLength, redo: () => assignDeep(deep.after), undo: () => assignDeep(deep.before) });
      else assignDeep(deep.after);
      return true;
    }
  }

  const before = layerDocumentPixels(target, document.state.width, document.state.height).slice();
  const confined = adjustedPixels(before, adjustment, document.state.selection);
  const assign = (pixels: Uint8ClampedArray) => { kernel.documents.update<RasterDocumentState>(document.id, (state) => { const layer = state.layers.find((item) => item.id === target.id); if (layer) setLayerPixels(layer, pixels, state.width, state.height, null, { keepOutsideDocument: true }); }); };
  if (history) void history.execute({ label: `Adjustment: ${name}`, memoryEstimate: before.byteLength + confined.byteLength, redo: () => assign(confined), undo: () => assign(before) }); else assign(confined);
  return true;
}
