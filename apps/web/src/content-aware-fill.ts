import { appendLayer, cloneRasterState, compositeRasterDocument, createRasterLayer, isRasterDocumentState, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { beginBusy } from "./busy";
import { confirmModal, errorModal } from "./modals/runtime";
import { defaultInpaintModelId, inpaintModelById } from "./ml/inpaint/registry";
import { runInpaint } from "./ml/inpaint/run";
import { useShellStore } from "./store";

/**
 * Content-Aware Fill for a pixel selection — Photoshop's Edit ▸ Content-Aware
 * Fill, and what its Contextual Task Bar calls "Remove" when something is
 * selected (master-plan §11.1's "Generative Fill + Remove", minus the part
 * that needs a text prompt and a cloud model: there is no prompt UI here
 * because there is nothing behind one, CLAUDE.md §3).
 *
 * No new engine: the same local MI-GAN/LaMa inpainting the Remove tool and the
 * crop tool's "AI border fill" already run (`ml/inpaint/run.ts`), with the
 * selection as the hole instead of a brushed mask. The result lands as a new
 * layer holding only the filled pixels, exactly as `fillExtendedBorder` does —
 * the owner's own rule for AI fills, and it leaves the original untouched.
 *
 * The weights are downloaded once, through the app's own consent dialog (the
 * same `confirmModal` + `kernel.models.isCached` pair the segmentation quick
 * actions use); refusing it simply cancels.
 */

const t = (en: string, ru: string) => useShellStore.getState().language === "ru" ? ru : en;

let running = false;

/** True when there is a selection to fill and no run in flight. */
export function contentAwareFillAvailable(documentId: string | null | undefined): boolean {
  const document = kernel.documents.get<RasterDocumentState>(documentId ?? "");
  return Boolean(!running && document && isRasterDocumentState(document.state) && document.state.selection);
}

export async function runContentAwareFill(documentId: string): Promise<void> {
  if (running) return;
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state) || !document.state.selection) return;
  const model = inpaintModelById(defaultInpaintModelId);
  if (!model) { errorModal({ title: t("No model available", "Нет доступной модели"), message: t("No inpainting model is registered.", "Не зарегистрирована ни одна модель для заполнения.") }); return; }

  if (!(await kernel.models.isCached(model.spec))) {
    const megabytes = (model.spec.sizeBytes / (1024 * 1024)).toFixed(1);
    const ok = await confirmModal({
      title: t("Download model?", "Скачать модель?"),
      message: t(
        `${model.label.en} (~${megabytes} MB) will be downloaded and cached in this browser — this happens once. Licence: ${model.spec.licence}.`,
        `${model.label.ru} (~${megabytes} МБ) будет загружена и закэширована в этом браузере — один раз. Лицензия: ${model.spec.licence}.`,
      ),
      confirmKey: `model:${model.id}`,
    });
    if (!ok) return;
  }

  running = true;
  const label = "Content-Aware Fill (Заливка с учётом содержимого)";
  const done = beginBusy(t("Filling the selection", "Заполнение выделения"));
  try {
    const live = kernel.documents.get<RasterDocumentState>(documentId);
    const state = live?.state;
    if (!state || !isRasterDocumentState(state) || !state.selection) return;
    const composite = compositeRasterDocument(state);
    // The model takes a hard hole: a feathered selection's soft rim is part of
    // what has to go, so anything selected at all is marked.
    const mask = new Uint8ClampedArray(state.width * state.height);
    for (let pixel = 0; pixel < mask.length; pixel += 1) mask[pixel] = state.selection.mask[pixel] ? 255 : 0;

    const outcome = await runInpaint(model, composite, state.width, state.height, mask);
    if (outcome.error) { errorModal({ title: t("Fill failed", "Не удалось заполнить"), message: `${model.id}: ${outcome.error}` }); return; }
    if (!outcome.pixels) return;

    const isolated = new Uint8ClampedArray(outcome.pixels.length);
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      if (!mask[pixel]) continue;
      const at = pixel * 4;
      isolated[at] = outcome.pixels[at]!; isolated[at + 1] = outcome.pixels[at + 1]!;
      isolated[at + 2] = outcome.pixels[at + 2]!; isolated[at + 3] = outcome.pixels[at + 3]!;
    }

    const before = cloneRasterState(state), after = cloneRasterState(state);
    const layer = createRasterLayer(after.width, after.height, label);
    setLayerPixels(layer, isolated, after.width, after.height);
    appendLayer(after, layer);
    after.activeLayerId = layer.id;

    const history = kernel.historyByDocument.get(documentId);
    if (!history) return;
    await history.execute({
      label,
      redo: () => { kernel.documents.update<RasterDocumentState>(documentId, (current) => { Object.assign(current, cloneRasterState(after)); }); },
      undo: () => { kernel.documents.update<RasterDocumentState>(documentId, (current) => { Object.assign(current, cloneRasterState(before)); }); },
    });
  } catch (error) {
    errorModal({ title: t("Fill failed", "Не удалось заполнить"), message: error instanceof Error ? error.message : String(error) });
  } finally {
    done();
    running = false;
  }
}
