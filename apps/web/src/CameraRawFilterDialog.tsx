import { useEffect, useMemo, useRef, useState } from "react";
import { applyCameraRawFilter, defaultCameraRawFilterSettings, type CameraRawFilterSettings, type RasterLayer } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";
import { CameraRawPanel, CameraRawTabs, downsampleForPreview, type CameraRawTab } from "./CameraRawPanels";

export function CameraRawFilterDialog({ layer, language, onApply, onClose }: { layer: RasterLayer; language: Language; onApply(pixels: Uint8ClampedArray, label: string): void; onClose(): void }) {
  const [settings, setSettings] = useState<CameraRawFilterSettings>(defaultCameraRawFilterSettings);
  const [tab, setTab] = useState<CameraRawTab>("basic");
  const [preview, setPreview] = useState<{ pixels: Uint8ClampedArray; width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const source = useMemo(() => downsampleForPreview(layer.pixels, layer.width, layer.height), [layer.pixels, layer.width, layer.height]);
  const t = (en: string, ru: string) => text(language, en, ru);

  // Debounced live preview at a downsampled size — the full-resolution pass (several box blurs
  // over the whole layer) runs once, on Apply, not on every slider tick.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setPreview({ pixels: applyCameraRawFilter(source.pixels, source.width, source.height, settings), width: source.width, height: source.height });
    }, 60);
    return () => clearTimeout(timeout);
  }, [settings, source]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas || !preview) return;
    canvas.width = preview.width; canvas.height = preview.height;
    const context = canvas.getContext("2d"); if (!context) return;
    context.putImageData(new ImageData(preview.pixels as Uint8ClampedArray<ArrayBuffer>, preview.width, preview.height), 0, 0);
  }, [preview]);

  const set = <K extends keyof CameraRawFilterSettings>(key: K, value: CameraRawFilterSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  const apply = () => {
    onApply(applyCameraRawFilter(layer.pixels, layer.width, layer.height, settings), "Camera Raw");
    onClose();
  };

  return <div className="dialog-backdrop camera-raw-filter-backdrop" onMouseDown={onClose}>
    <section className="camera-raw-filter-dialog" role="dialog" aria-modal="true" aria-label="Camera Raw Filter" onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>{t("Camera Raw Filter", "Фильтр Camera Raw")}</strong><button onClick={onClose}>×</button></header>
      <div className="camera-raw-filter-body">
        <div className="camera-raw-filter-preview"><canvas ref={canvasRef} /></div>
        <aside className="camera-raw-filter-settings">
          <CameraRawTabs tab={tab} onChange={setTab} language={language} />
          <CameraRawPanel tab={tab} settings={settings} language={language} onChange={set} />
        </aside>
      </div>
      <footer>
        <button onClick={() => setSettings(defaultCameraRawFilterSettings)}>{t("Reset", "Сбросить")}</button>
        <button onClick={onClose}>{t("Cancel", "Отмена")}</button>
        <button className="primary" onClick={apply}>{t("OK", "ОК")}</button>
      </footer>
    </section>
  </div>;
}
