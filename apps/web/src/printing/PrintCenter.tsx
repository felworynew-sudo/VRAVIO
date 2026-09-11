import { useEffect, useMemo, useRef, useState } from "react";
import { compositeRasterDocument, type RasterDocumentState } from "@vravio/env-raster";
import { text } from "../i18n";
import type { Language } from "../store";
import {
  calculatePrintPlacement, defaultPrintSettings, documentPpi, pageLayoutFor, paperSizes,
  PRINT_PREVIEW_DPI, renderPrintPageFromPixels, type PrintSettings,
} from "../printImage";
import { dispatchSystemPrint } from "./dispatch";
import { createPrintPdf, printPdfFileName } from "./pdf";
import { listNativePrinters, sendNativePrint, type NativePrinter } from "./native-desktop";
import { isDesktop } from "../desktop-window";

export function PrintCenter({ state, documentName, language, onCancel, onSavePdf }: {
  state: RasterDocumentState;
  documentName: string;
  language: Language;
  onCancel(): void;
  onSavePdf(blob: Blob, fileName: string): void | Promise<void>;
}) {
  const [settings, setSettings] = useState<PrintSettings>({ ...defaultPrintSettings, areaMode: state.selection ? defaultPrintSettings.areaMode : "document" });
  const [busy, setBusy] = useState<"print" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printers, setPrinters] = useState<readonly NativePrinter[]>([]);
  const [printerName, setPrinterName] = useState("");
  const [copies, setCopies] = useState(1);
  const [grayscale, setGrayscale] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const set = <Key extends keyof PrintSettings>(key: Key, value: PrintSettings[Key]) => setSettings((current) => ({ ...current, [key]: value }));
  const page = pageLayoutFor(settings);
  const placement = calculatePrintPlacement(state, settings, page);
  const ppi = documentPpi(state);
  // Layer compositing is the expensive part. Layout controls must only redraw the already
  // flattened source, never recomposite every layer on each slider input.
  const compositePixels = useMemo(() => compositeRasterDocument(state), [state]);

  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    void listNativePrinters().then((next) => {
      if (disposed) return;
      setPrinters(next);
      setPrinterName((current) => current || next.find((printer) => printer.isDefault)?.name || next[0]?.name || "");
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, []);

  // A setting drag only renders a compact 96-DPI page after it settles. The
  // 300-DPI page is made once, on Print or Save PDF, so the editor stays live.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const canvas = previewRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const rendered = renderPrintPageFromPixels(state, settings, compositePixels, true, PRINT_PREVIEW_DPI);
      const scale = Math.min(canvas.width / rendered.width, canvas.height / rendered.height);
      const width = Math.max(1, Math.round(rendered.width * scale)), height = Math.max(1, Math.round(rendered.height * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
      context.drawImage(rendered, Math.floor((canvas.width - width) / 2), Math.floor((canvas.height - height) / 2), width, height);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [state, settings, compositePixels]);

  const renderFinalPage = () => renderPrintPageFromPixels(state, settings, compositePixels);
  const print = async () => {
    setBusy("print"); setError(null);
    try {
      const rendered = renderFinalPage();
      if (isDesktop) {
        if (!printerName) throw new Error(text(language, "No installed printer is available.", "Не найден установленный принтер."));
        await sendNativePrint({ printerName, title: documentName, page: rendered, layout: page, orientation: settings.orientation, copies, grayscale });
      } else await dispatchSystemPrint(rendered, page);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const savePdf = async () => {
    setBusy("pdf"); setError(null);
    try { await onSavePdf(await createPrintPdf(renderFinalPage(), page), printPdfFileName(documentName)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  return <div className="dialog-backdrop export-backdrop" onMouseDown={onCancel}>
    <section className="export-dialog print-center" role="dialog" aria-modal="true" aria-labelledby="print-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><small>{text(language, "PRINT CENTER", "ЦЕНТР ПЕЧАТИ")}</small><h2 id="print-title">{text(language, "Print image", "Печать изображения")}</h2></div>
        <button onClick={onCancel} aria-label={text(language, "Close", "Закрыть")}>×</button>
      </header>
      <div className="export-body">
        <div className="export-preview print-preview">
          <canvas ref={previewRef} width={440} height={370} />
          <small>{placement.effectiveScalePercent.toFixed(0)}% · {placement.targetWidthIn.toFixed(2)} × {placement.targetHeightIn.toFixed(2)} in · {ppi.toFixed(0)} ppi</small>
          <span>{text(language, "Preview is compact; output is prepared at 300 DPI.", "Предпросмотр компактный; печать готовится в 300 DPI.")}</span>
        </div>
        <aside className="export-settings">
          <strong className="print-settings-title">{text(language, "Page layout", "Макет страницы")}</strong>
          {isDesktop && <><label className="export-field"><span>{text(language, "Printer", "Принтер")}</span><select value={printerName} disabled={!printers.length} onChange={(event) => setPrinterName(event.target.value)}>{printers.length ? printers.map((printer) => <option key={printer.name} value={printer.name}>{printer.name}{printer.isDefault ? text(language, " (default)", " (по умолчанию)") : ""}</option>) : <option>{text(language, "Loading printers…", "Загрузка принтеров…")}</option>}</select></label><label className="export-field"><span>{text(language, "Copies", "Копии")}</span><input type="number" min={1} max={999} value={copies} onChange={(event) => setCopies(Math.max(1, Math.min(999, event.target.valueAsNumber || 1)))} /></label><label className="export-check"><input type="checkbox" checked={grayscale} onChange={(event) => setGrayscale(event.target.checked)} /><span>{text(language, "Print in grayscale", "Печать в оттенках серого")}</span></label></>}
          <label className="export-field"><span>{text(language, "Paper size", "Размер бумаги")}</span><select value={settings.paperSizeId} onChange={(event) => set("paperSizeId", event.target.value)}>{paperSizes.map((paper) => <option key={paper.id} value={paper.id}>{paper.label}</option>)}</select></label>
          <label className="export-field"><span>{text(language, "Orientation", "Ориентация")}</span><select value={settings.orientation} onChange={(event) => set("orientation", event.target.value as PrintSettings["orientation"])}><option value="portrait">{text(language, "Portrait", "Книжная")}</option><option value="landscape">{text(language, "Landscape", "Альбомная")}</option></select></label>
          <label className="export-field"><span>{text(language, "Margins (in)", "Поля (дюймы)")}</span><div className="export-margins">{(["marginTopIn", "marginRightIn", "marginBottomIn", "marginLeftIn"] as const).map((key) => <input key={key} aria-label={key} type="number" min={0} max={5} step={0.1} value={settings[key]} onChange={(event) => set(key, Math.max(0, event.target.valueAsNumber || 0))} />)}</div></label>
          {state.selection && <label className="export-field"><span>{text(language, "Print area", "Область печати")}</span><select value={settings.areaMode} onChange={(event) => set("areaMode", event.target.value as PrintSettings["areaMode"])}><option value="document">{text(language, "Whole document", "Весь документ")}</option><option value="selection">{text(language, "Selection", "Выделение")}</option></select></label>}
          <label className="export-field"><span>{text(language, "Scale", "Масштаб")}</span><select value={settings.scaleMode} onChange={(event) => set("scaleMode", event.target.value as PrintSettings["scaleMode"])}><option value="fit">{text(language, "Fit to page", "Вписать в страницу")}</option><option value="actual">{text(language, "Actual size (document PPI)", "Реальный размер (по PPI документа)")}</option><option value="custom">{text(language, "Custom", "Свой")}</option></select></label>
          {settings.scaleMode === "custom" && <label className="export-field export-slider"><span>{text(language, "Scale %", "Масштаб, %")}</span><input type="range" min={1} max={400} value={settings.scalePercent} onChange={(event) => set("scalePercent", event.target.valueAsNumber)} /><output>{settings.scalePercent}%</output></label>}
          <label className="export-check"><input type="checkbox" checked={settings.center} onChange={(event) => set("center", event.target.checked)} /><span>{text(language, "Center on page", "По центру страницы")}</span></label>
          {!settings.center && <><label className="export-field"><span>{text(language, "Offset X (in)", "Смещение X (дюймы)")}</span><input type="number" step={0.1} value={settings.offsetXIn} onChange={(event) => set("offsetXIn", event.target.valueAsNumber || 0)} /></label><label className="export-field"><span>{text(language, "Offset Y (in)", "Смещение Y (дюймы)")}</span><input type="number" step={0.1} value={settings.offsetYIn} onChange={(event) => set("offsetYIn", event.target.valueAsNumber || 0)} /></label></>}
          <label className="export-check"><input type="checkbox" checked={settings.cropMarks} onChange={(event) => set("cropMarks", event.target.checked)} /><span>{text(language, "Crop marks", "Метки обрезки")}</span></label>
          <div className="export-estimate"><b>{page.widthIn.toFixed(2)} × {page.heightIn.toFixed(2)} in</b><small>{isDesktop ? text(language, "The desktop app sends this page directly to the selected printer.", "Desktop-версия отправляет страницу напрямую в выбранный принтер.") : text(language, "Paper, printer and driver options open in the system dialog.", "Бумага, принтер и настройки драйвера открываются в системном диалоге.")}</small></div>
          {error && <p className="print-error" role="alert">{error}</p>}
        </aside>
      </div>
      <footer><button onClick={onCancel}>{text(language, "Cancel", "Отмена")}</button><button disabled={busy !== null} onClick={() => void savePdf()}>{busy === "pdf" ? text(language, "Preparing…", "Подготовка…") : text(language, "Save PDF", "Сохранить PDF")}</button><button className="primary" disabled={busy !== null || (isDesktop && !printerName)} onClick={() => void print()}>{busy === "print" ? text(language, "Preparing…", "Подготовка…") : text(language, "Print", "Печать")}</button></footer>
    </section>
  </div>;
}
