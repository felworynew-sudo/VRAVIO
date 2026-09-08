import { useEffect, useRef, useState } from "react";
import type { RasterDocumentState } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";
import {
  calculatePrintPlacement, defaultPrintSettings, documentPpi, openPrintPreview, pageLayoutFor, paperSizes,
  renderPrintPage, type PrintSettings,
} from "./printImage";

export function PrintDialog({ state, language, onCancel }: {
  state: RasterDocumentState;
  language: Language;
  onCancel(): void;
}) {
  const [settings, setSettings] = useState<PrintSettings>({ ...defaultPrintSettings, areaMode: state.selection ? defaultPrintSettings.areaMode : "document" });
  const [busy, setBusy] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const set = <Key extends keyof PrintSettings>(key: Key, value: PrintSettings[Key]) => setSettings((current) => ({ ...current, [key]: value }));

  const page = pageLayoutFor(settings);
  const placement = calculatePrintPlacement(state, settings, page);
  const ppi = documentPpi(state);

  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const rendered = renderPrintPage(state, settings, true);
    const scale = Math.min(canvas.width / rendered.width, canvas.height / rendered.height);
    const width = Math.max(1, Math.round(rendered.width * scale)), height = Math.max(1, Math.round(rendered.height * scale));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#00000022"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(rendered, Math.floor((canvas.width - width) / 2), Math.floor((canvas.height - height) / 2), width, height);
  }, [state, settings]);

  const run = () => {
    setBusy(true);
    try {
      const rendered = renderPrintPage(state, settings, false);
      openPrintPreview(rendered.toDataURL("image/png"), page);
    } finally {
      setBusy(false);
    }
  };

  return <div className="dialog-backdrop export-backdrop" onMouseDown={onCancel}>
    <section className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="print-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><small>{text(language, "PRINT", "ПЕЧАТЬ")}</small><h2 id="print-title">{text(language, "Print image", "Печать изображения")}</h2></div>
        <button onClick={onCancel} aria-label={text(language, "Close", "Закрыть")}>×</button>
      </header>

      <div className="export-body">
        <div className="export-preview">
          <canvas ref={previewRef} width={360} height={300} />
          <small>{placement.effectiveScalePercent.toFixed(0)}% · {placement.targetWidthIn.toFixed(2)} × {placement.targetHeightIn.toFixed(2)} in · {ppi.toFixed(0)} ppi</small>
        </div>

        <aside className="export-settings">
          <label className="export-field">
            <span>{text(language, "Paper size", "Размер бумаги")}</span>
            <select value={settings.paperSizeId} onChange={(event) => set("paperSizeId", event.target.value)}>
              {paperSizes.map((paper) => <option key={paper.id} value={paper.id}>{paper.label}</option>)}
            </select>
          </label>

          <label className="export-field">
            <span>{text(language, "Orientation", "Ориентация")}</span>
            <select value={settings.orientation} onChange={(event) => set("orientation", event.target.value as PrintSettings["orientation"])}>
              <option value="portrait">{text(language, "Portrait", "Книжная")}</option>
              <option value="landscape">{text(language, "Landscape", "Альбомная")}</option>
            </select>
          </label>

          <label className="export-field">
            <span>{text(language, "Margins (in)", "Поля (дюймы)")}</span>
            <div className="export-margins">
              {(["marginTopIn", "marginRightIn", "marginBottomIn", "marginLeftIn"] as const).map((key) => <input key={key} type="number" min={0} max={5} step={0.1} value={settings[key]} onChange={(event) => set(key, Math.max(0, event.target.valueAsNumber || 0))} />)}
            </div>
          </label>

          {state.selection && <label className="export-field">
            <span>{text(language, "Print area", "Область печати")}</span>
            <select value={settings.areaMode} onChange={(event) => set("areaMode", event.target.value as PrintSettings["areaMode"])}>
              <option value="document">{text(language, "Whole document", "Весь документ")}</option>
              <option value="selection">{text(language, "Selection", "Выделение")}</option>
            </select>
          </label>}

          <label className="export-field">
            <span>{text(language, "Scale", "Масштаб")}</span>
            <select value={settings.scaleMode} onChange={(event) => set("scaleMode", event.target.value as PrintSettings["scaleMode"])}>
              <option value="fit">{text(language, "Fit to page", "Вписать в страницу")}</option>
              <option value="actual">{text(language, "Actual size (document PPI)", "Реальный размер (по PPI документа)")}</option>
              <option value="custom">{text(language, "Custom", "Свой")}</option>
            </select>
          </label>

          {settings.scaleMode === "custom" && <label className="export-field export-slider">
            <span>{text(language, "Scale %", "Масштаб, %")}</span>
            <input type="range" min={1} max={400} value={settings.scalePercent} onChange={(event) => set("scalePercent", event.target.valueAsNumber)} />
            <output>{settings.scalePercent}%</output>
          </label>}

          <label className="export-check">
            <input type="checkbox" checked={settings.center} onChange={(event) => set("center", event.target.checked)} />
            <span>{text(language, "Center on page", "По центру страницы")}</span>
          </label>

          {!settings.center && <>
            <label className="export-field">
              <span>{text(language, "Offset X (in)", "Смещение X (дюймы)")}</span>
              <input type="number" step={0.1} value={settings.offsetXIn} onChange={(event) => set("offsetXIn", event.target.valueAsNumber || 0)} />
            </label>
            <label className="export-field">
              <span>{text(language, "Offset Y (in)", "Смещение Y (дюймы)")}</span>
              <input type="number" step={0.1} value={settings.offsetYIn} onChange={(event) => set("offsetYIn", event.target.valueAsNumber || 0)} />
            </label>
          </>}

          <label className="export-check">
            <input type="checkbox" checked={settings.cropMarks} onChange={(event) => set("cropMarks", event.target.checked)} />
            <span>{text(language, "Crop marks", "Метки обрезки")}</span>
          </label>

          <div className="export-estimate">
            <b>{page.widthIn.toFixed(2)} × {page.heightIn.toFixed(2)} in</b>
            <small>{text(language, "Page size", "Размер страницы")}</small>
          </div>
        </aside>
      </div>

      <footer>
        <button onClick={onCancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" disabled={busy} onClick={run}>{busy ? text(language, "Preparing…", "Подготовка…") : text(language, "Print", "Печать")}</button>
      </footer>
    </section>
  </div>;
}
