import { useEffect, useMemo, useRef, useState } from "react";
import { applyCameraRawFilter, defaultCameraRawFilterSettings, layerPixelsView, type CameraRawFilterSettings, type RasterLayer } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";
import { CameraRawPanel, CameraRawTabs, downsampleForPreview, type CameraRawTab } from "./CameraRawPanels";
import { runDenoise } from "./ml/denoise/run";
import { defaultDenoiseModelId, denoiseModelById } from "./ml/denoise/registry";
import { kernel } from "./kernel";
import { confirmModal } from "./modals/runtime";
import { ModalBackdrop } from "./modals/ModalBackdrop";

export function CameraRawFilterDialog({ layer, language, onApply, onClose }: { layer: RasterLayer; language: Language; onApply(pixels: Uint8ClampedArray, label: string): void; onClose(): void }) {
  const [settings, setSettings] = useState<CameraRawFilterSettings>(defaultCameraRawFilterSettings);
  const [tab, setTab] = useState<CameraRawTab>("basic");
  const [preview, setPreview] = useState<{ pixels: Uint8ClampedArray; width: number; height: number } | null>(null);
  const [aiDenoiseOn, setAiDenoiseOn] = useState(false);
  const [aiDenoising, setAiDenoising] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const source = useMemo(() => downsampleForPreview(layerPixelsView(layer), layer.width, layer.height), [layer, layer.pixelsRevision, layer.width, layer.height]);
  const t = (en: string, ru: string) => text(language, en, ru);

  // Debounced live preview at a downsampled size — the full-resolution pass (several box blurs
  // over the whole layer) runs once, on Apply, not on every slider tick. AI Denoise runs after
  // the classic pipeline as a discrete post-process, same reasoning as `CameraRawDialog.tsx`'s
  // own identical effect (the two entry points to one develop panel, `CameraRawPanels.tsx`'s own
  // doc comment) — too slow to redo per tick, so it reruns only on the toggle or a settings change.
  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      const filtered = applyCameraRawFilter(source.pixels, source.width, source.height, settings);
      if (!aiDenoiseOn) { setPreview({ pixels: filtered, width: source.width, height: source.height }); return; }
      setAiDenoising(true);
      void (async () => {
        const model = denoiseModelById(defaultDenoiseModelId);
        if (!model) { if (!cancelled) setPreview({ pixels: filtered, width: source.width, height: source.height }); return; }
        if (!(await kernel.models.isCached(model.spec))) {
          const megabytes = (model.spec.sizeBytes / (1024 * 1024)).toFixed(1);
          const ok = await confirmModal({
            title: t("Download model?", "Скачать модель?"),
            message: t(`${model.label.en} (~${megabytes} MB) will be downloaded and cached in this browser — this happens once. Licence: ${model.spec.licence}.`, `${model.label.ru} (~${megabytes} МБ) будет загружена и закэширована в этом браузере — один раз. Лицензия: ${model.spec.licence}.`),
            confirmKey: `model:${model.id}`,
          });
          if (!ok) { if (!cancelled) { setAiDenoiseOn(false); setPreview({ pixels: filtered, width: source.width, height: source.height }); } return; }
        }
        const outcome = await runDenoise(model, filtered, source.width, source.height, {});
        if (cancelled) return;
        setPreview({ pixels: outcome.pixels ?? filtered, width: source.width, height: source.height });
      })().finally(() => { if (!cancelled) setAiDenoising(false); });
    }, 60);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [settings, source, aiDenoiseOn]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas || !preview) return;
    canvas.width = preview.width; canvas.height = preview.height;
    const context = canvas.getContext("2d"); if (!context) return;
    context.putImageData(new ImageData(preview.pixels as Uint8ClampedArray<ArrayBuffer>, preview.width, preview.height), 0, 0);
  }, [preview]);

  const set = <K extends keyof CameraRawFilterSettings>(key: K, value: CameraRawFilterSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  const apply = async () => {
    let pixels = applyCameraRawFilter(layerPixelsView(layer), layer.width, layer.height, settings);
    if (aiDenoiseOn) {
      const model = denoiseModelById(defaultDenoiseModelId);
      if (model) { const outcome = await runDenoise(model, pixels, layer.width, layer.height, {}); if (outcome.pixels) pixels = outcome.pixels; }
    }
    onApply(pixels, "Camera Raw");
    onClose();
  };

  return <ModalBackdrop className="camera-raw-filter-backdrop" onMouseDown={onClose}>
    <section className="camera-raw-filter-dialog" role="dialog" aria-modal="true" aria-label="Camera Raw Filter" onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>{t("Camera Raw Filter", "Фильтр Camera Raw")}</strong><button onClick={onClose}>×</button></header>
      <div className="camera-raw-filter-body">
        <div className="camera-raw-filter-preview"><canvas ref={canvasRef} /></div>
        <aside className="camera-raw-filter-settings">
          <CameraRawTabs tab={tab} onChange={setTab} language={language} />
          <CameraRawPanel tab={tab} settings={settings} language={language} onChange={set} aiDenoiseOn={aiDenoiseOn} aiDenoiseBusy={aiDenoising} onAiDenoiseChange={setAiDenoiseOn} />
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
