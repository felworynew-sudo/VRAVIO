import { useCallback, useMemo, useState } from "react";
import { defaultCameraRawFilterSettings, layerPixelsView, type CameraRawFilterSettings, type RasterLayer } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";
import { CameraRawPanel, CameraRawTabs, type CameraRawTab } from "./CameraRawPanels";
import { CameraRawViewport, type CameraRawPostProcess } from "./CameraRawViewport";
import { renderCameraRaw } from "./camera-raw-pool";
import { withBusy } from "./busy";
import { runDenoise } from "./ml/denoise/run";
import { defaultDenoiseModelId, denoiseModelById } from "./ml/denoise/registry";
import { kernel } from "./kernel";
import { confirmModal } from "./modals/runtime";
import { ModalBackdrop } from "./modals/ModalBackdrop";

export function CameraRawFilterDialog({ layer, language, onApply, onClose }: { layer: RasterLayer; language: Language; onApply(pixels: Uint8ClampedArray, label: string): void; onClose(): void }) {
  const [settings, setSettings] = useState<CameraRawFilterSettings>(defaultCameraRawFilterSettings);
  const [tab, setTab] = useState<CameraRawTab>("basic");
  const [aiDenoiseOn, setAiDenoiseOn] = useState(false);
  const [aiDenoising, setAiDenoising] = useState(false);
  const image = useMemo(() => ({ pixels: layerPixelsView(layer), width: layer.width, height: layer.height }), [layer, layer.pixelsRevision, layer.width, layer.height]);
  const t = (en: string, ru: string) => text(language, en, ru);

  /**
   * AI Denoise is asked for once, when switched on — consent for the model download there, not on
   * every settings tick — and then runs after the develop pipeline on exactly the region the
   * preview shows (docs/master-plan.md §58.1: it used to rerun over the whole preview on every
   * change, and over the whole layer synchronously on OK).
   */
  const toggleAiDenoise = async (on: boolean) => {
    if (!on) { setAiDenoiseOn(false); return; }
    const model = denoiseModelById(defaultDenoiseModelId);
    if (!model) return;
    if (!(await kernel.models.isCached(model.spec))) {
      const megabytes = (model.spec.sizeBytes / (1024 * 1024)).toFixed(1);
      const ok = await confirmModal({
        title: t("Download model?", "Скачать модель?"),
        message: t(`${model.label.en} (~${megabytes} MB) will be downloaded and cached in this browser — this happens once. Licence: ${model.spec.licence}.`, `${model.label.ru} (~${megabytes} МБ) будет загружена и закэширована в этом браузере — один раз. Лицензия: ${model.spec.licence}.`),
        confirmKey: `model:${model.id}`,
      });
      if (!ok) return;
    }
    setAiDenoiseOn(true);
  };
  const denoise = useCallback<CameraRawPostProcess>(async (pixels, width, height, signal) => {
    const model = denoiseModelById(defaultDenoiseModelId);
    if (!model) return pixels;
    const outcome = await runDenoise(model, pixels, width, height, { signal });
    return outcome.pixels ?? pixels;
  }, []);

  const set = <K extends keyof CameraRawFilterSettings>(key: K, value: CameraRawFilterSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  const apply = async () => {
    const pixels = await withBusy(t("Applying Camera Raw", "Применение Camera Raw"), async () => {
      let rendered = await renderCameraRaw({ pixels: layerPixelsView(layer), width: layer.width, height: layer.height, settings });
      if (aiDenoiseOn) rendered = await denoise(rendered, layer.width, layer.height, new AbortController().signal);
      return rendered;
    });
    onApply(pixels, "Camera Raw");
    onClose();
  };

  return <ModalBackdrop className="camera-raw-filter-backdrop" onMouseDown={onClose}>
    <section className="camera-raw-filter-dialog" role="dialog" aria-modal="true" aria-label="Camera Raw Filter" onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>{t("Camera Raw Filter", "Фильтр Camera Raw")}</strong><button onClick={onClose}>×</button></header>
      <div className="camera-raw-filter-body">
        <div className="camera-raw-filter-preview"><CameraRawViewport image={image} settings={settings} language={language} postProcess={aiDenoiseOn ? denoise : undefined} onRenderingChange={(rendering) => setAiDenoising(aiDenoiseOn && rendering)} /></div>
        <aside className="camera-raw-filter-settings">
          <CameraRawTabs tab={tab} onChange={setTab} language={language} />
          <CameraRawPanel tab={tab} settings={settings} language={language} onChange={set} aiDenoiseOn={aiDenoiseOn} aiDenoiseBusy={aiDenoising} onAiDenoiseChange={(on) => void toggleAiDenoise(on)} />
        </aside>
      </div>
      <footer>
        <button onClick={() => setSettings(defaultCameraRawFilterSettings)}>{t("Reset", "Сбросить")}</button>
        <button onClick={onClose}>{t("Cancel", "Отмена")}</button>
        <button className="primary" onClick={() => void apply()}>{t("OK", "ОК")}</button>
      </footer>
    </section>
  </ModalBackdrop>;
}
