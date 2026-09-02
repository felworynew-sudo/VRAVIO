import { useEffect, useMemo, useRef, useState } from "react";
import type { RasterDocumentState } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";
import {
  defaultExportSettings, encodeExport, exportFileName, exportFormatInfo, exportFormats, exportPixelSize,
  formatBytes, renderExportCanvas, supportedExportFormats, type ExportFormat, type ExportSettings,
} from "./exportImage";

const scalePresets = [0.25, 0.5, 1, 2, 3, 4] as const;

export function ExportDialog({ state, documentName, language, onCancel, onExport }: {
  state: RasterDocumentState;
  documentName: string;
  language: Language;
  onCancel(): void;
  onExport(blob: Blob, fileName: string): void | Promise<void>;
}) {
  const [settings, setSettings] = useState<ExportSettings>(defaultExportSettings);
  const [supported, setSupported] = useState<ReadonlySet<ExportFormat> | null>(null);
  const [useTarget, setUseTarget] = useState(false);
  const [targetKb, setTargetKb] = useState(500);
  const [estimate, setEstimate] = useState<{ bytes: number; quality: number; missed?: boolean } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const info = exportFormatInfo(settings.format);
  const size = exportPixelSize(state, settings.scale);
  const fileName = exportFileName(documentName, settings.format);
  // A target size only means something for formats that can trade quality for bytes. Keeping
  // the toggle's value while switching to PNG/PDF would otherwise surface an unreachable-target
  // warning the user has no visible control to clear.
  const targetBytes = info.lossy && useTarget ? targetKb * 1024 : undefined;
  const set = <Key extends keyof ExportSettings>(key: Key, value: ExportSettings[Key]) => setSettings((current) => ({ ...current, [key]: value }));
  const safeScale = (scale: number) => settings.format === "ico" ? Math.min(scale, 256 / Math.max(state.width, state.height)) : scale;

  useEffect(() => { void supportedExportFormats().then(setSupported); }, []);

  // The preview is a thumbnail of the real export pipeline, so flattening and
  // background choices are visible before committing to a file.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const rendered = renderExportCanvas(state, { ...settings, scale: 1 });
    const scale = Math.min(canvas.width / rendered.width, canvas.height / rendered.height);
    const width = Math.max(1, Math.round(rendered.width * scale)), height = Math.max(1, Math.round(rendered.height * scale));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(rendered, Math.floor((canvas.width - width) / 2), Math.floor((canvas.height - height) / 2), width, height);
  }, [state, settings]);

  // Encoding a large document is slow, so the size readout is debounced and always
  // reflects the newest settings rather than whichever encode happened to finish last.
  useEffect(() => {
    let cancelled = false;
    setEstimating(true);
    const timer = setTimeout(async () => {
      try {
        const result = await encodeExport(state, settings, targetBytes);
        if (!cancelled) setEstimate({ bytes: result.blob.size, quality: result.quality, ...(result.targetMissed ? { missed: true } : {}) });
      } catch {
        if (!cancelled) setEstimate(null);
      } finally {
        if (!cancelled) setEstimating(false);
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); setEstimating(false); };
  }, [state, settings, targetBytes]);

  const availableFormats = useMemo(() => exportFormats.filter((candidate) => !supported || supported.has(candidate.format)), [supported]);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const result = await encodeExport(state, settings, targetBytes);
      await onExport(result.blob, fileName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <div className="dialog-backdrop export-backdrop" onMouseDown={onCancel}>
    <section className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><small>{text(language, "EXPORT", "ЭКСПОРТ")}</small><h2 id="export-title">{text(language, "Export image", "Экспорт изображения")}</h2></div>
        <button onClick={onCancel} aria-label={text(language, "Close", "Закрыть")}>×</button>
      </header>

      <div className="export-body">
        <div className="export-preview">
          <canvas ref={previewRef} width={360} height={300} />
          <small>{size.width} × {size.height} px</small>
        </div>

        <aside className="export-settings">
          <label className="export-field">
            <span>{text(language, "Format", "Формат")}</span>
            <select value={settings.format} onChange={(event) => {
              const format = event.target.value as ExportFormat;
              const nextInfo = exportFormatInfo(format);
              setSettings((current) => ({ ...current, format, ...(!nextInfo.alpha && current.colorMode === "rgba" ? { colorMode: "rgb" as const } : {}), ...(format === "ico" && Math.max(state.width, state.height) * current.scale > 256 ? { scale: 256 / Math.max(state.width, state.height) } : {}) }));
            }}>
              {availableFormats.map((candidate) => <option key={candidate.format} value={candidate.format}>{candidate.label}</option>)}
            </select>
          </label>
          <small className="export-format-note">{info.notes}</small>

          <label className="export-field">
            <span>{text(language, "Scale", "Масштаб")}</span>
            <select value={scalePresets.includes(settings.scale as typeof scalePresets[number]) ? String(settings.scale) : "custom"} onChange={(event) => { if (event.target.value !== "custom") set("scale", safeScale(Number(event.target.value))); }}>
              {scalePresets.filter((preset) => settings.format !== "ico" || Math.max(state.width, state.height) * preset <= 256).map((preset) => <option key={preset} value={preset}>{preset * 100}%</option>)}
              {!scalePresets.includes(settings.scale as typeof scalePresets[number]) && <option value="custom">{Math.round(settings.scale * 100)}%</option>}
            </select>
          </label>

          <label className="export-field">
            <span>{text(language, "Width", "Ширина")}</span>
            <input type="number" min={1} max={settings.format === "ico" ? 256 : 20000} value={size.width} onChange={(event) => { const next = Math.min(settings.format === "ico" ? 256 : 20000, event.target.valueAsNumber); if (next > 0) set("scale", safeScale(next / state.width)); }} />
          </label>

          <label className="export-field">
            <span>{text(language, "Height", "Высота")}</span>
            <input type="number" min={1} max={settings.format === "ico" ? 256 : 20000} value={size.height} onChange={(event) => { const next = Math.min(settings.format === "ico" ? 256 : 20000, event.target.valueAsNumber); if (next > 0) set("scale", safeScale(next / state.height)); }} />
          </label>

          <label className="export-field">
            <span>{text(language, "Resampling", "Интерполяция")}</span>
            <select value={settings.resampling} onChange={(event) => set("resampling", event.target.value as ExportSettings["resampling"])}>
              <option value="bicubic">{text(language, "Bicubic / high quality", "Бикубическая / высокое качество")}</option>
              <option value="bilinear">{text(language, "Bilinear / fast", "Билинейная / быстро")}</option>
              <option value="nearest">{text(language, "Nearest / pixel art", "По соседнему / пиксель-арт")}</option>
            </select>
          </label>

          <label className="export-field">
            <span>{text(language, "Colour mode", "Цветовой режим")}</span>
            <select value={settings.colorMode} onChange={(event) => set("colorMode", event.target.value as ExportSettings["colorMode"])}>
              {info.alpha && <option value="rgba">RGBA · 32 bit</option>}
              <option value="rgb">RGB · 24 bit</option>
              <option value="grayscale">{text(language, "Grayscale", "Градации серого")}</option>
              <option value="monochrome">{text(language, "Monochrome · 1 bit", "Монохром · 1 бит")}</option>
              <option value="indexed">{text(language, "Indexed palette", "Индексированная палитра")}</option>
            </select>
          </label>

          {(settings.colorMode === "indexed" || settings.colorMode === "grayscale") && <label className="export-field export-slider">
            <span>{text(language, "Palette colours", "Цветов палитры")}</span>
            <input type="range" min={2} max={256} value={settings.paletteColors} onChange={(event) => set("paletteColors", event.target.valueAsNumber)} />
            <output>{settings.paletteColors}</output>
          </label>}

          {(settings.colorMode === "monochrome" || settings.colorMode === "grayscale") && <label className="export-check">
            <input type="checkbox" checked={settings.dither} onChange={(event) => set("dither", event.target.checked)} />
            <span>{text(language, "Floyd–Steinberg dithering", "Дизеринг Флойда—Стейнберга")}</span>
          </label>}

          {info.lossy && <label className="export-field export-slider">
            <span>{text(language, "Quality", "Качество")}</span>
            <input type="range" min={2} max={100} disabled={useTarget} value={Math.round(settings.quality * 100)} onChange={(event) => set("quality", event.target.valueAsNumber / 100)} />
            <output>{Math.round((useTarget ? estimate?.quality ?? settings.quality : settings.quality) * 100)}</output>
          </label>}

          {!info.alpha && <label className="export-field">
            <span>{text(language, "Matte", "Подложка")}</span>
            <input type="color" value={settings.background} onChange={(event) => set("background", event.target.value)} />
          </label>}

          {info.lossy && <label className="export-check">
            <input type="checkbox" checked={useTarget} onChange={(event) => setUseTarget(event.target.checked)} />
            <span>{text(language, "Target file size", "Целевой вес файла")}</span>
          </label>}

          {info.lossy && useTarget && <label className="export-field">
            <span>{text(language, "Target", "Цель")}</span>
            <input type="number" min={5} max={50000} value={targetKb} onChange={(event) => setTargetKb(Math.max(5, event.target.valueAsNumber || 5))} />
            <i>KB</i>
          </label>}

          <div className="export-estimate">
            <b>{estimating ? text(language, "Estimating…", "Оценка…") : estimate ? formatBytes(estimate.bytes) : "—"}</b>
            <small>{fileName}</small>
            {estimate?.missed && <em>{text(language, "Target not reachable at this size — lower the scale.", "Цель недостижима при таком размере — уменьшите масштаб.")}</em>}
            {error && <em>{error}</em>}
          </div>
        </aside>
      </div>

      <footer>
        <button onClick={onCancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" disabled={busy} onClick={() => void run()}>{busy ? text(language, "Exporting…", "Экспорт…") : text(language, "Export", "Экспортировать")}</button>
      </footer>
    </section>
  </div>;
}
