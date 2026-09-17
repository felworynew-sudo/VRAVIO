import { activeRasterLayer, createRasterLayerMaskFromSelection, isRasterDocumentState, layerPixelsView, selectionBounds, type PixelSelection, type RasterDocumentState, type RasterLayer, type RasterLayerMask } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { beginBusy } from "./busy";
import { confirmModal, errorModal } from "./modals/runtime";
import { runSegmentation } from "./ml/segment/run";
import { defaultSegmentModelId, segmentModelById } from "./ml/segment/registry";
import { useShellStore } from "./store";

/**
 * Remove Background and Select Subject — both on the lightweight U²-Net-P
 * segmentation model (`ml/segment/definitions/u2netp.ts`).
 *
 * These lived inside `RasterPixelLayerProperties.tsx` as the Properties
 * panel's Quick Actions, reachable from that one panel only. Photoshop offers
 * the same pair from its Contextual Task Bar on a pixel layer with nothing
 * selected (master-plan §11), so the logic moved here, behind the
 * `select.subject` / `layer.removeBackground` commands, and both the panel and
 * the bar call the commands — one implementation, several doors.
 *
 * Runs on the active layer's own pixels, in its own bounds — not the full
 * document composite. For the common case (one photo on one layer) that is
 * the same image either way; on a document with several layers this finds
 * the subject within whatever this one layer itself contains, which is a
 * real, deliberate scoping choice, not an oversight.
 */

export type SegmentQuickAction = "remove" | "select";

const t = (en: string, ru: string) => useShellStore.getState().language === "ru" ? ru : en;

/** Places a mask sized to a layer's own bounds into a document-sized buffer
 * at the layer's offset, clipped to the document — `PixelSelection.mask` and
 * `RasterLayerMask.pixels` are both one byte per *document* pixel, but a
 * layer (and the model run over its own pixels) works in bounds-local
 * coordinates (see `RasterLayer.bounds`'s own doc comment in types.ts). */
export function documentMaskFromLayerMask(layerMask: Uint8ClampedArray, layer: RasterLayer, docWidth: number, docHeight: number): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(docWidth * docHeight);
  const { x: ox, y: oy, width, height } = layer.bounds;
  for (let y = 0; y < height; y += 1) {
    const dy = oy + y;
    if (dy < 0 || dy >= docHeight) continue;
    for (let x = 0; x < width; x += 1) {
      const dx = ox + x;
      if (dx < 0 || dx >= docWidth) continue;
      mask[dy * docWidth + dx] = layerMask[y * width + x]!;
    }
  }
  return mask;
}

/** Same shape as `raster-commit.ts`'s own `commitSelection` — that one lives
 * inside `useRasterCommit`, a hook tied to the canvas component, and is not
 * reachable from here. */
async function commitSelection(documentId: string, before: PixelSelection | null, after: PixelSelection | null, label: string): Promise<void> {
  const history = kernel.historyByDocument.get(documentId);
  if (!history) return;
  const clone = (selection: PixelSelection | null): PixelSelection | null => selection ? { mask: selection.mask.slice(), bounds: { ...selection.bounds } } : null;
  const assign = (selection: PixelSelection | null): void => { kernel.documents.update<RasterDocumentState>(documentId, (state) => { state.selection = clone(selection); }); };
  await history.execute({ label, redo: () => assign(after), undo: () => assign(before) });
}

async function commitLayerMask(documentId: string, layerId: string, before: RasterLayerMask | undefined, after: RasterLayerMask, label: string): Promise<void> {
  const history = kernel.historyByDocument.get(documentId);
  if (!history) return;
  const clone = (mask: RasterLayerMask | undefined): RasterLayerMask | undefined => mask ? { ...mask, tiles: mask.tiles.clone() } : undefined;
  const assign = (mask: RasterLayerMask | undefined): void => { kernel.documents.update<RasterDocumentState>(documentId, (state) => { const layer = state.layers.find((item) => item.id === layerId); if (!layer) return; if (mask) layer.mask = mask; else delete layer.mask; }); };
  await history.execute({ label, redo: () => assign(clone(after)), undo: () => assign(clone(before)) });
}

let running: SegmentQuickAction | null = null;

/** Which quick action is in flight, if any — one model run at a time. */
export const runningSegmentQuickAction = (): SegmentQuickAction | null => running;

/** True when the active layer of this document is one a quick action can run on. */
export function segmentQuickActionAvailable(documentId: string | null | undefined): boolean {
  const document = kernel.documents.get<RasterDocumentState>(documentId ?? "");
  return Boolean(running === null && document && isRasterDocumentState(document.state) && activeRasterLayer(document.state)?.kind === "pixel");
}

export async function runSegmentQuickAction(documentId: string, kind: SegmentQuickAction): Promise<void> {
  if (running) return;
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const layer = activeRasterLayer(document.state);
  if (layer?.kind !== "pixel") return;

  const model = segmentModelById(defaultSegmentModelId);
  if (!model) { errorModal({ title: t("No model available", "Нет доступной модели"), message: t("No segmentation model is registered.", "Не зарегистрирована ни одна модель сегментации.") }); return; }

  if (!(await kernel.models.isCached(model.spec))) {
    const megabytes = (model.spec.sizeBytes / (1024 * 1024)).toFixed(1);
    const ok = await confirmModal({
      title: t("Download model?", "Скачать модель?"),
      message: t(
        `${model.label.en} (~${megabytes} MB) will be downloaded from Hugging Face and cached in this browser — this happens once. Licence: ${model.spec.licence}.`,
        `${model.label.ru} (~${megabytes} МБ) будет загружена с Hugging Face и закэширована в этом браузере — один раз. Лицензия: ${model.spec.licence}.`,
      ),
      confirmKey: `model:${model.id}`,
    });
    if (!ok) return;
  }

  running = kind;
  const done = beginBusy(kind === "remove" ? t("Removing background", "Удаление фона") : t("Selecting subject", "Выделение объекта"));
  try {
    const outcome = await runSegmentation(model, layerPixelsView(layer), layer.bounds.width, layer.bounds.height);
    if (outcome.error) { errorModal({ title: t("Segmentation failed", "Сегментация не удалась"), message: outcome.error }); return; }
    if (!outcome.mask) return;

    // Read again: the model run is long enough for the document to have moved on.
    const state = kernel.documents.get<RasterDocumentState>(documentId)?.state;
    if (!state || !isRasterDocumentState(state)) return;
    const documentMask = documentMaskFromLayerMask(outcome.mask, layer, state.width, state.height);
    const bounds = selectionBounds(documentMask, state.width, state.height);
    if (!bounds.width || !bounds.height) { errorModal({ title: t("Nothing found", "Ничего не найдено"), message: t("The model did not find a subject on this layer.", "Модель не нашла объект на этом слое.") }); return; }

    if (kind === "select") {
      await commitSelection(documentId, state.selection, { mask: documentMask, bounds }, t("Select Subject", "Выделить объект"));
    } else {
      const current = state.layers.find((item) => item.id === layer.id);
      if (!current) return;
      const nextMask = createRasterLayerMaskFromSelection({ mask: documentMask, bounds }, state.width, state.height);
      await commitLayerMask(documentId, layer.id, current.mask, nextMask, t("Remove Background", "Удалить фон"));
    }
  } catch (error) {
    errorModal({ title: t("Segmentation failed", "Сегментация не удалась"), message: error instanceof Error ? error.message : String(error) });
  } finally {
    done();
    running = null;
  }
}
