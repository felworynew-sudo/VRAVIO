import { isRasterDocumentState, type RasterDocumentState, type RasterLayerKind, type RasterTextData, type RasterAdjustment } from "@vravio/env-raster";
import { kernel } from "./kernel";

/**
 * Converts a non-pixel layer (text, an adjustment layer, …) into a plain
 * pixel layer, keeping whatever pixels it already had baked/rendered. The
 * one door for this conversion: `RasterWorkspace.tsx`'s own on-canvas "this
 * tool needs pixels" prompt and `harmonize-commands.ts`'s Quick
 * Harmonization command both call this rather than each flipping
 * `layer.kind` themselves — see CLAUDE.md §4 on why a duplicate of a
 * multi-field invariant like this one (kind *and* the two fields that only
 * make sense for the old kind) is two futures that drift apart, not two
 * places doing the same safe thing.
 *
 * Resolves to whether the layer was (or already was) a pixel layer — `false`
 * only when the layer itself no longer exists, so a caller that already
 * asked the user "rasterize?" and got "yes" can tell a real failure from the
 * ordinary case of nothing left to do.
 */
export async function rasterizeLayer(documentId: string, layerId: string): Promise<boolean> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return false;
  const layer = document.state.layers.find((item) => item.id === layerId);
  if (!layer) return false;
  if (layer.kind === "pixel") return true;

  const beforeKind: RasterLayerKind = layer.kind, beforeText: RasterTextData | undefined = layer.text, beforeAdjustment: RasterAdjustment | undefined = layer.adjustment;
  const write = (kind: RasterLayerKind, text: RasterTextData | undefined, adjustment: RasterAdjustment | undefined) =>
    kernel.documents.update<RasterDocumentState>(documentId, (current) => {
      const target = current.layers.find((item) => item.id === layerId);
      if (!target) return;
      target.kind = kind;
      if (text) target.text = text; else delete target.text;
      if (adjustment) target.adjustment = adjustment; else delete target.adjustment;
    });

  write("pixel", undefined, undefined);
  const history = kernel.historyByDocument.get(documentId);
  if (history) {
    await history.execute({
      label: "Rasterize Layer (Растрировать слой)",
      redo: () => { write("pixel", undefined, undefined); },
      undo: () => { write(beforeKind, beforeText, beforeAdjustment); },
    });
  }
  return true;
}
