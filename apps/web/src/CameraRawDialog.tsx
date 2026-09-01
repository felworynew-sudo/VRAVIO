import { useEffect, useRef, useState } from "react";
import LibRaw from "libraw-wasm";
import { defaultCameraRawSettings, decodeRawBuffer, fallbackToEmbeddedPreview, type CameraRawSettings, type DecodedRaw } from "./rawDecode";
import { text } from "./i18n";
import type { Language } from "./store";

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

export function CameraRawDialog({ buffer, filename, language, mode, onCancel, onConfirm }: { buffer: ArrayBuffer; filename: string; language: Language; mode: "open" | "reprocess"; onCancel(): void; onConfirm(result: DecodedRaw): void }) {
  const [settings, setSettings] = useState<CameraRawSettings>(defaultCameraRawSettings);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<DecodedRaw | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (frameRef.current !== null) clearTimeout(frameRef.current);
    frameRef.current = window.setTimeout(() => {
      decodePreview(buffer, filename, settings).then((result) => {
        if (cancelled) return;
        setLoading(false);
        if (!result) { setError(text(language, "This file could not be previewed.", "Не удалось построить превью этого файла.")); return; }
        setPreview(result);
      });
    }, 120);
    return () => { cancelled = true; if (frameRef.current !== null) clearTimeout(frameRef.current); };
  }, [buffer, settings, language]);

  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context || !preview) return;
    canvas.width = preview.width; canvas.height = preview.height;
    context.putImageData(new ImageData(preview.pixels as Uint8ClampedArray<ArrayBuffer>, preview.width, preview.height), 0, 0);
  }, [preview]);

  const [applying, setApplying] = useState(false);
  const confirm = async () => {
    setApplying(true);
    const result = await decodeRawBuffer(buffer, filename, settings);
    setApplying(false);
    if (result) onConfirm(result); else setError(text(language, "Could not develop this RAW file at full resolution.", "Не удалось проявить этот RAW-файл в полном разрешении."));
  };

  const set = <K extends keyof CameraRawSettings>(key: K, value: CameraRawSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  return <div className="dialog-backdrop camera-raw-backdrop" onMouseDown={onCancel}>
    <section className="camera-raw-dialog" role="dialog" aria-modal="true" aria-label="Camera Raw" onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>Camera Raw — {filename}</strong><button onClick={onCancel}>×</button></header>
      <div className="camera-raw-body">
        <div className="camera-raw-preview">
          {loading && !preview && <div className="camera-raw-status">{text(language, "Decoding…", "Декодирование…")}</div>}
          {error && <div className="camera-raw-status error">{error}</div>}
          {preview && <canvas ref={canvasRef}/>}
        </div>
        <aside className="camera-raw-settings">
          <label>{text(language, "White Balance", "Баланс белого")}<select value={settings.useAutoWb ? "auto" : settings.useCameraWb ? "camera" : "asShot"} onChange={(event) => { const value = event.target.value; set("useAutoWb", value === "auto"); set("useCameraWb", value === "camera"); }}>
            <option value="camera">{text(language, "As Shot (Camera)", "Как снято (камера)")}</option>
            <option value="auto">{text(language, "Auto", "Авто")}</option>
            <option value="asShot">{text(language, "Neutral", "Нейтральный")}</option>
          </select></label>
          <label>{text(language, "Exposure", "Экспозиция")}<input type="range" min={0.25} max={4} step={0.05} value={settings.exposure} onChange={(event) => set("exposure", event.target.valueAsNumber)}/><output>{settings.exposure.toFixed(2)}×</output></label>
          <label>{text(language, "Brightness", "Яркость")}<input type="range" min={0.2} max={3} step={0.05} value={settings.brightness} onChange={(event) => set("brightness", event.target.valueAsNumber)}/><output>{settings.brightness.toFixed(2)}×</output></label>
          <label>{text(language, "Highlight Recovery", "Восстановление светов")}<input type="range" min={0} max={9} step={1} value={settings.highlight} onChange={(event) => set("highlight", event.target.valueAsNumber)}/><output>{settings.highlight}</output></label>
          <p className="camera-raw-note">{text(language, "Full demosaic RAW develop via LibRaw. Output is 8-bit sRGB.", "Полный демозаик через LibRaw. Вывод — 8-бит sRGB.")}</p>
        </aside>
      </div>
      <footer><button onClick={onCancel}>{text(language, "Cancel", "Отмена")}</button><button className="primary" disabled={applying} onClick={() => void confirm()}>{applying ? text(language, "Developing…", "Проявка…") : mode === "open" ? text(language, "Open", "Открыть") : text(language, "Apply", "Применить")}</button></footer>
    </section>
  </div>;
}
