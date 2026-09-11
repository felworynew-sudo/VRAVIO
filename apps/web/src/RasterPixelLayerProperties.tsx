import { useState } from "react";
import { createRasterLayerMaskFromSelection, selectionBounds, type PixelSelection, type RasterDocumentState, type RasterLayer, type RasterLayerMask } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { beginBusy } from "./busy";
import { confirmModal, errorModal } from "./modals/runtime";
import { runSegmentation } from "./ml/segment/run";
import { defaultSegmentModelId, segmentModelById } from "./ml/segment/registry";
import type { Language } from "./store";

/**
 * The Properties panel's Quick Actions for a plain pixel layer — Remove
 * Background and Select Subject, both on the lightweight U²-Net-P
 * segmentation model (`ml/segment/definitions/u2netp.ts`), the model
 * docs/master-plan.md §12/§14 already names for exactly this pair of
 * actions and this exact panel location ("не повторять Photoshop-путь через
 * Discover, а держать Remove Background/Select Subject прямо в
 * Properties → Quick Actions").
 *
 * Runs on the active layer's own pixels, in its own bounds — not the full
 * document composite. For the common case (one photo on one layer) that is
 * the same image either way; on a document with several layers this finds
 * the subject within whatever this one layer itself contains, which is a
 * real, deliberate scoping choice for this first pass, not an oversight.
 *
 * Perspective and Align & Distribute, the other two sections in the
 * owner's Photoshop screenshot for this same panel, are not here yet:
 * Perspective for a pixel layer means actually resampling and moving pixel
 * content (unlike the text layer's panel, which had a non-destructive
 * transform matrix to reuse), and Align & Distribute has no existing
 * multi-layer alignment logic anywhere in this codebase to call into. Both
 * are real, separate pieces of work — deferred rather than rushed under an
 * already large change.
 */

const t = (language: Language, en: string, ru: string) => language === "ru" ? ru : en;

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
 * reachable from a dock panel. The logic is small enough that duplicating
 * it here (clone, then one `history.execute`) beats threading the hook's
 * instance across the dock boundary for a single call site. */
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
  const clone = (mask: RasterLayerMask | undefined): RasterLayerMask | undefined => mask ? { ...mask, pixels: mask.pixels.slice() } : undefined;
  const assign = (mask: RasterLayerMask | undefined): void => { kernel.documents.update<RasterDocumentState>(documentId, (state) => { const layer = state.layers.find((item) => item.id === layerId); if (!layer) return; if (mask) layer.mask = mask; else delete layer.mask; }); };
  await history.execute({ label, redo: () => assign(clone(after)), undo: () => assign(clone(before)) });
}

export function RasterPixelLayerProperties({ documentId, document, layer, language }: { documentId: string; document: RasterDocumentState; layer: RasterLayer; language: Language }) {
  const [running, setRunning] = useState<"remove" | "select" | null>(null);

  const runQuickAction = async (kind: "remove" | "select") => {
    if (running) return;
    const model = segmentModelById(defaultSegmentModelId);
    if (!model) { errorModal({ title: t(language, "No model available", "Нет доступной модели"), message: t(language, "No segmentation model is registered.", "Не зарегистрирована ни одна модель сегментации.") }); return; }

    if (!(await kernel.models.isCached(model.spec))) {
      const megabytes = (model.spec.sizeBytes / (1024 * 1024)).toFixed(1);
      const ok = await confirmModal({
        title: t(language, "Download model?", "Скачать модель?"),
        message: t(
          language,
          `${model.label.en} (~${megabytes} MB) will be downloaded from Hugging Face and cached in this browser — this happens once. Licence: ${model.spec.licence}.`,
          `${model.label.ru} (~${megabytes} МБ) будет загружена с Hugging Face и закэширована в этом браузере — один раз. Лицензия: ${model.spec.licence}.`,
        ),
        confirmKey: `model:${model.id}`,
      });
      if (!ok) return;
    }

    setRunning(kind);
    const done = beginBusy(kind === "remove" ? t(language, "Removing background", "Удаление фона") : t(language, "Selecting subject", "Выделение объекта"));
    try {
      const outcome = await runSegmentation(model, layer.pixels, layer.bounds.width, layer.bounds.height);
      if (outcome.error) { errorModal({ title: t(language, "Segmentation failed", "Сегментация не удалась"), message: outcome.error }); return; }
      if (!outcome.mask) return;

      const documentMask = documentMaskFromLayerMask(outcome.mask, layer, document.width, document.height);
      const bounds = selectionBounds(documentMask, document.width, document.height);
      if (!bounds.width || !bounds.height) { errorModal({ title: t(language, "Nothing found", "Ничего не найдено"), message: t(language, "The model did not find a subject on this layer.", "Модель не нашла объект на этом слое.") }); return; }

      if (kind === "select") {
        await commitSelection(documentId, document.selection, { mask: documentMask, bounds }, t(language, "Select Subject", "Выделить объект"));
      } else {
        const nextMask = createRasterLayerMaskFromSelection({ mask: documentMask, bounds });
        await commitLayerMask(documentId, layer.id, layer.mask, nextMask, t(language, "Remove Background", "Удалить фон"));
      }
    } catch (error) {
      errorModal({ title: t(language, "Segmentation failed", "Сегментация не удалась"), message: error instanceof Error ? error.message : String(error) });
    } finally {
      done();
      setRunning(null);
    }
  };

  return <div className="dock-panel-body property-stack text-properties">
    <header className="text-props-header"><span className="text-props-header-icon">□</span><strong>{t(language, "Pixel layer", "Пиксельный слой")}</strong></header>
    <details className="text-props-section" open>
      <summary>{t(language, "Quick Actions", "Быстрые действия")}</summary>
      <div className="text-props-section-body">
        <button type="button" className="panel-action" disabled={running !== null} onClick={() => void runQuickAction("remove")}>
          {running === "remove" ? t(language, "Removing background…", "Удаление фона…") : t(language, "Remove Background", "Удалить фон")}
        </button>
        <button type="button" className="panel-action" disabled={running !== null} onClick={() => void runQuickAction("select")}>
          {running === "select" ? t(language, "Selecting subject…", "Выделение объекта…") : t(language, "Select Subject", "Выделить объект")}
        </button>
      </div>
    </details>
  </div>;
}
