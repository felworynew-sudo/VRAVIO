import { useState } from "react";
import { compositeRasterDocument, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { useShellStore } from "./store";
import { beginBusy } from "./busy";
import { confirmModal, errorModal } from "./modals/runtime";
import { runUpscale } from "./ml/upscale/run";
import { defaultUpscaleModelId, upscaleModelById, upscaleModels } from "./ml/upscale/registry";
import { text as t } from "./i18n";
import type { Language } from "./store";

/**
 * Image → Generative Upscale… (docs/master-plan.md §52.3).
 *
 * Owner's own direction: the whole open document is upscaled into a *new*
 * document next to it ("original name upscale"), not edited in place. That
 * sidesteps the scoping question a single-layer, in-place resize would have
 * raised (this project has no "Image Size" yet — no generic "scale a layer
 * of any kind" to call into for a multi-layer document) — the source stays
 * exactly as it was, and what comes out is one flat layer at the model's own
 * scale, the same way "File → Export" or "Merge Visible" already flattens
 * without pretending to preserve every layer's own kind.
 */

export function GenerativeUpscaleDialog({ documentId, document, language, onClose }: { documentId: string; document: RasterDocumentState; language: Language; onClose(): void }) {
  const [modelId, setModelId] = useState(defaultUpscaleModelId);
  const [running, setRunning] = useState(false);
  const model = upscaleModelById(modelId);
  const newWidth = (document.width * (model?.scale ?? 1)) | 0;
  const newHeight = (document.height * (model?.scale ?? 1)) | 0;

  const apply = async () => {
    if (!model || running) return;

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

    setRunning(true);
    const done = beginBusy(t(language, "Upscaling", "Увеличение разрешения"));
    try {
      const composite = compositeRasterDocument(document);
      const outcome = await runUpscale(model, composite, document.width, document.height);
      if (outcome.error) { errorModal({ title: t(language, "Upscale failed", "Не удалось увеличить разрешение"), message: outcome.error }); return; }
      if (!outcome.pixels) return;

      const sourceName = kernel.documents.get(documentId)?.name ?? "";
      const name = t(language, `${sourceName} upscale`, `${sourceName} upscale`);
      useShellStore.getState().openDocument("raster", {
        name, width: outcome.width, height: outcome.height,
        resolution: document.resolution, resolutionUnit: document.resolutionUnit,
        backgroundColor: null, pixelAspectRatio: document.pixelAspectRatio,
      });
      const newDocumentId = useShellStore.getState().activeDocumentId;
      if (newDocumentId) {
        kernel.documents.update<RasterDocumentState>(newDocumentId, (state) => {
          setLayerPixels(state.layers[0]!, outcome.pixels!, outcome.width, outcome.height);
        });
      }
      onClose();
    } catch (error) {
      errorModal({ title: t(language, "Upscale failed", "Не удалось увеличить разрешение"), message: error instanceof Error ? error.message : String(error) });
    } finally {
      done();
      setRunning(false);
    }
  };

  return <div className="dialog-backdrop rasterize-confirm-backdrop" onMouseDown={onClose}>
    <section className="rasterize-confirm upscale-dialog" role="dialog" aria-modal="true" aria-label={t(language, "Generative Upscale", "Генеративное увеличение масштаба")} onMouseDown={(event) => event.stopPropagation()}>
      <header className="upscale-dialog-header"><strong>{t(language, "Generative Upscale", "Генеративное увеличение масштаба")}</strong><button onClick={onClose}>×</button></header>
      <div className="upscale-body">
        <label>{t(language, "Model", "Нейросеть")}
          <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={running}>
            {upscaleModels.map((entry) => <option key={entry.id} value={entry.id}>{t(language, entry.label.en, entry.label.ru ?? entry.label.en)}</option>)}
          </select>
        </label>
        {model && <div className="panel-hint">
          {`${document.width}×${document.height} → ${newWidth}×${newHeight} (×${model.scale})`}
        </div>}
        <div className="panel-hint">
          {t(language, "Creates a new document at the larger size, next to this one.", "Создаёт новый документ в большем разрешении, рядом с этим.")}
        </div>
      </div>
      <footer>
        <button onClick={onClose}>{t(language, "Cancel", "Отмена")}</button>
        <button className="primary" disabled={!model || running} onClick={() => void apply()}>
          {running ? t(language, "Upscaling…", "Увеличение…") : t(language, "Upscale", "Увеличить")}
        </button>
      </footer>
    </section>
  </div>;
}
