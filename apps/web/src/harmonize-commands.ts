import { clampRegionToDocument, compositeRasterDocument, computeLabStats, harmonizeToReference, isRasterDocumentState, layerContentBounds, layerDocumentPixels, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { rasterizeLayer } from "./raster-rasterize";
import { confirmModal } from "./modals/runtime";
import { useShellStore } from "./store";
import { text } from "./i18n";

/**
 * How far past a layer's own bounds to sample "the scene it needs to match"
 * — Photoshop's own Harmonize reads a margin of context around the pasted
 * object, not just its own footprint: there is no "background" to speak of
 * *inside* a layer's own opaque pixels, only outside them, and the far
 * corners of a large document are not "the lighting this object sits in".
 */
const CONTEXT_MARGIN_FACTOR = 0.5;

/**
 * Matches a layer's own Lab color statistics to the scene around it — see
 * `harmonize.ts`'s own doc comment for why this is a multi-scale Reinhard
 * color-transfer and not a neural model. A destructive pixel edit, the same
 * as any other one-shot filter applied directly to a layer (not an
 * adjustment layer): undoable through the ordinary history door, not part of
 * the non-destructive `scene3d` data a 3D layer's own rotation/material
 * edits go through, since this is a grade on the rendered result, not a
 * property of the scene itself. Reached through `quickHarmonizeLayer` below
 * (Изображение ▸ Коррекция ▸ Быстрая гармонизация), which rasterizes first
 * when the layer needs it; call this directly only once a layer is already
 * known to be `kind: "pixel"`.
 */
export async function harmonizeLayer(documentId: string, layerId: string, strength = 1): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const state = document.state;
  const layer = state.layers.find((item) => item.id === layerId);
  if (!layer) return;

  const before = layerDocumentPixels(layer, state.width, state.height);
  const bounds = layerContentBounds(before, state.width, state.height);
  if (!bounds.width || !bounds.height) return;

  const source = computeLabStats(before, state.width, state.height, bounds);
  if (!source) return;

  const withoutLayer = compositeRasterDocument({ ...state, layers: state.layers.map((item) => item.id === layerId ? { ...item, visible: false } : item) });
  const marginX = bounds.width * CONTEXT_MARGIN_FACTOR, marginY = bounds.height * CONTEXT_MARGIN_FACTOR;
  const contextRegion = clampRegionToDocument(state, { x: bounds.x - marginX, y: bounds.y - marginY, width: bounds.width + marginX * 2, height: bounds.height + marginY * 2 });
  const reference = computeLabStats(withoutLayer, state.width, state.height, contextRegion);
  // Nothing behind the layer to match against — an empty canvas, or the
  // layer fills the whole document — leaves it exactly as it was rather
  // than harmonizing toward a statistic that does not mean anything.
  if (!reference) return;

  const after = harmonizeToReference(before, state.width, state.height, source, reference, strength, bounds);
  const write = (pixels: Uint8ClampedArray) => kernel.documents.update<RasterDocumentState>(documentId, (current) => {
    const target = current.layers.find((item) => item.id === layerId);
    if (target) setLayerPixels(target, pixels, current.width, current.height);
  });
  write(after);
  const history = kernel.historyByDocument.get(documentId);
  if (history) await history.execute({ label: "Harmonize Layer (Гармонизация слоя)", redo: () => { write(after); }, undo: () => { write(before); } });
}

/**
 * Изображение ▸ Коррекция ▸ Быстрая гармонизация — the owner's own
 * reclassification of this feature: a one-shot smart filter baked into a
 * layer on the spot, not a live-preview object property, and reached from
 * the Image menu rather than a layer's right-click menu (which used to gate
 * it to 3D layers only). No dialog by default: applies immediately, the same
 * "click and it's done" shape `invertCommand` already uses for a pixel-only
 * adjustment in `adjustments.ts`.
 *
 * Grading pixels in place only means something once the target layer has
 * pixels of its own to grade — a text or adjustment layer's `.pixels` is
 * only a rendered cache (see `RASTER_ONLY_TOOLS`'s own comment in
 * `RasterWorkspace.tsx`), and writing into that cache directly would desync
 * it from the live data it is drawn from. Asks before rasterizing rather
 * than doing it silently, the same confirmation `RasterWorkspace.tsx`'s own
 * "this tool needs pixels" prompt already uses for every other
 * pixel-destructive tool.
 */
export async function quickHarmonizeLayer(documentId: string, layerId: string, strength = 1): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const layer = document.state.layers.find((item) => item.id === layerId);
  if (!layer) return;

  if (layer.kind !== "pixel") {
    const language = useShellStore.getState().language;
    const confirmed = await confirmModal({
      title: text(language, "This filter needs pixels", "Этому фильтру нужны пиксели"),
      message: text(
        language,
        `"${layer.name}" has no pixels of its own yet. Rasterize it into a normal pixel layer first?`,
        `У слоя «${layer.name}» ещё нет собственных пикселей. Растрировать его в обычный слой с пикселями?`,
      ),
      confirmLabel: text(language, "Rasterize Layer", "Растрировать слой"),
    });
    if (!confirmed) return;
    const rasterized = await rasterizeLayer(documentId, layerId);
    if (!rasterized) return;
  }

  await harmonizeLayer(documentId, layerId, strength);
}
