import { useEffect, useRef, useState } from "react";
import LibRaw from "libraw-wasm";
import { applyCameraRawFilter, defaultCameraRawFilterSettings, type CameraRawFilterSettings } from "@vravio/env-raster";
import { defaultCameraRawSettings, decodeRawBuffer, fallbackToEmbeddedPreview, type CameraRawSettings, type DecodedRaw } from "./rawDecode";
import { text } from "./i18n";
import type { Language } from "./store";
import { CameraRawPanel, CameraRawTabs, type CameraRawTab } from "./CameraRawPanels";

async function decodePreview(buffer: ArrayBuffer, filename: string, settings: CameraRawSettings): Promise<DecodedRaw | null> {
  const raw = new LibRaw();
  try {
    await raw.open(new Uint8Array(buffer.slice(0)), { outputBps: 8, outputColor: 1, halfSize: true, useCameraWb: settings.useCameraWb, useAutoWb: settings.useAutoWb, expCorrec: true, expShift: settings.exposure, bright: settings.brightness, highlight: settings.highlight });
    const image = await raw.imageData();
    raw.dispose();
    if (!image) return fallbackToEmbeddedPreview(buffer, filename);
    const pixels = new Uint8ClampedArray(image.width * image.height * 4);
    for (let pixel = 0, source = 0; pixel < image.width * image.height; pixel += 1, source += image.colors) { const target = pixel * 4; pixels[target] = image.data[source]!; pixels[target + 1] = image.data[source + (image.colors >= 2 ? 1 : 0)]!; pixels[target + 2] = image.data[source + (image.colors >= 3 ? 2 : 0)]!; pixels[target + 3] = 255; }
    return { width: image.width, height: image.height, pixels };
  } catch { raw.dispose(); return fallbackToEmbeddedPreview(buffer, filename); }
}

/**
 * Photoshop's Camera Raw dialog is the same develop panel as Filter > Camera Raw Filter
 * (`CameraRawPanels.tsx`), just reached with undeveloped sensor data instead of an already-
 * rasterized layer. LibRaw does only what genuinely needs raw sensor data — demosaic, white
 * balance at the RAW level, and highlight recovery from data an 8-bit render has already
 * clipped — everything else (exposure, tone, texture/clarity/dehaze, curve, detail, HSL,
 * effects) runs through the exact same `applyCameraRawFilter` the filter dialog uses, so this
 * dialog is no longer stuck at the four raw-level knobs LibRaw itself exposes.
 */
export function CameraRawDialog({ buffer, filename, language, mode, onCancel, onConfirm }: { buffer: ArrayBuffer; filename: string; language: Language; mode: "open" | "reprocess"; onCancel(): void; onConfirm(result: DecodedRaw): void }) {
  const [rawSettings, setRawSettings] = useState<CameraRawSettings>(defaultCameraRawSettings);
  const [filterSettings, setFilterSettings] = useState<CameraRawFilterSettings>(defaultCameraRawFilterSettings);
  const [tab, setTab] = useState<CameraRawTab>("basic");
  const [loading, setLoading] = useState(true);
  const [decoded, setDecoded] = useState<DecodedRaw | null>(null);
  const [preview, setPreview] = useState<DecodedRaw | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);

  // Re-decodes from the sensor data — only needed when a raw-level setting (white balance mode,
  // highlight recovery) changes, not on every develop-panel slider tick.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (frameRef.current !== null) clearTimeout(frameRef.current);
    frameRef.current = window.setTimeout(() => {
      decodePreview(buffer, filename, rawSettings).then((result) => {
        if (cancelled) return;
        setLoading(false);
        if (!result) { setError(text(language, "This file could not be previewed.", "Не удалось построить превью этого файла.")); return; }
        setDecoded(result);
      });
    }, 120);
    return () => { cancelled = true; if (frameRef.current !== null) clearTimeout(frameRef.current); };
  }, [buffer, rawSettings, filename, language]);

  // Runs the develop panel over the already-decoded preview — cheap enough for every slider tick.
  useEffect(() => {
    if (!decoded) return;
    setPreview({ width: decoded.width, height: decoded.height, pixels: applyCameraRawFilter(decoded.pixels, decoded.width, decoded.height, filterSettings) });
  }, [decoded, filterSettings]);

  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context || !preview) return;
    canvas.width = preview.width; canvas.height = preview.height;
    context.putImageData(new ImageData(preview.pixels as Uint8ClampedArray<ArrayBuffer>, preview.width, preview.height), 0, 0);
  }, [preview]);

  const [applying, setApplying] = useState(false);
  const confirm = async () => {
    setApplying(true);
    const full = await decodeRawBuffer(buffer, filename, rawSettings);
    setApplying(false);
    if (!full) { setError(text(language, "Could not develop this RAW file at full resolution.", "Не удалось проявить этот RAW-файл в полном разрешении.")); return; }
    onConfirm({ width: full.width, height: full.height, pixels: applyCameraRawFilter(full.pixels, full.width, full.height, filterSettings) });
  };

  const setRaw = <K extends keyof CameraRawSettings>(key: K, value: CameraRawSettings[K]) => setRawSettings((current) => ({ ...current, [key]: value }));
  const setFilter = <K extends keyof CameraRawFilterSettings>(key: K, value: CameraRawFilterSettings[K]) => setFilterSettings((current) => ({ ...current, [key]: value }));

  return <div className="dialog-backdrop camera-raw-backdrop" onMouseDown={onCancel}>
    <section className="camera-raw-filter-dialog" role="dialog" aria-modal="true" aria-label="Camera Raw" onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>Camera Raw — {filename}</strong><button onClick={onCancel}>×</button></header>
      <div className="camera-raw-filter-body">
        <div className="camera-raw-filter-preview">
          {loading && !preview && <div className="camera-raw-status">{text(language, "Decoding…", "Декодирование…")}</div>}
          {error && <div className="camera-raw-status error">{error}</div>}
          {preview && <canvas ref={canvasRef}/>}
        </div>
        <aside className="camera-raw-filter-settings">
          <div className="camera-raw-filter-panel camera-raw-raw-panel">
            <strong>{text(language, "Raw develop", "Проявка RAW")}</strong>
            <label className="camera-raw-slider camera-raw-wb-select"><span>{text(language, "White Balance", "Баланс белого")}</span><select value={rawSettings.useAutoWb ? "auto" : rawSettings.useCameraWb ? "camera" : "asShot"} onChange={(event) => { const value = event.target.value; setRaw("useAutoWb", value === "auto"); setRaw("useCameraWb", value === "camera"); }}>
              <option value="camera">{text(language, "As Shot (Camera)", "Как снято (камера)")}</option>
              <option value="auto">{text(language, "Auto", "Авто")}</option>
              <option value="asShot">{text(language, "Neutral", "Нейтральный")}</option>
            </select></label>
            <label className="camera-raw-slider"><span>{text(language, "Highlight Recovery", "Восстановление светов")}</span><input type="range" min={0} max={9} step={1} value={rawSettings.highlight} onChange={(event) => setRaw("highlight", event.target.valueAsNumber)}/><output>{rawSettings.highlight}</output></label>
          </div>
          <CameraRawTabs tab={tab} onChange={setTab} language={language} />
          <CameraRawPanel tab={tab} settings={filterSettings} language={language} onChange={setFilter} />
        </aside>
      </div>
      <footer><button onClick={onCancel}>{text(language, "Cancel", "Отмена")}</button><button className="primary" disabled={applying} onClick={() => void confirm()}>{applying ? text(language, "Developing…", "Проявка…") : mode === "open" ? text(language, "Open", "Открыть") : text(language, "Apply", "Применить")}</button></footer>
    </section>
  </div>;
}
