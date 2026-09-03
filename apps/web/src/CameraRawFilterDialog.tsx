import { useEffect, useMemo, useRef, useState } from "react";
import { applyCameraRawFilter, defaultCameraRawFilterSettings, type CameraRawFilterSettings, type HslChannelName, type RasterLayer } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";

const hslChannels: { key: HslChannelName; en: string; ru: string; swatch: string }[] = [
  { key: "red", en: "Red", ru: "Красный", swatch: "#e5484d" }, { key: "orange", en: "Orange", ru: "Оранжевый", swatch: "#f76b15" },
  { key: "yellow", en: "Yellow", ru: "Жёлтый", swatch: "#ffe629" }, { key: "green", en: "Green", ru: "Зелёный", swatch: "#30a46c" },
  { key: "aqua", en: "Aqua", ru: "Бирюзовый", swatch: "#12a594" }, { key: "blue", en: "Blue", ru: "Синий", swatch: "#0090ff" },
  { key: "purple", en: "Purple", ru: "Фиолетовый", swatch: "#8e4ec6" }, { key: "magenta", en: "Magenta", ru: "Пурпурный", swatch: "#d6409f" },
];

type Tab = "basic" | "curve" | "detail" | "hsl" | "effects";

function downsample(pixels: Uint8ClampedArray, width: number, height: number, maxEdge: number): { pixels: Uint8ClampedArray; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) return { pixels, width, height };
  const outWidth = Math.max(1, Math.round(width * scale)), outHeight = Math.max(1, Math.round(height * scale));
  const output = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) for (let x = 0; x < outWidth; x += 1) {
    const sourceX = Math.min(width - 1, Math.floor(x / scale)), sourceY = Math.min(height - 1, Math.floor(y / scale));
    const from = (sourceY * width + sourceX) * 4, to = (y * outWidth + x) * 4;
    output[to] = pixels[from]!; output[to + 1] = pixels[from + 1]!; output[to + 2] = pixels[from + 2]!; output[to + 3] = pixels[from + 3]!;
  }
  return { pixels: output, width: outWidth, height: outHeight };
}

/** A slider row bound to one numeric field of the settings object — every Basic/Effects/Detail
 * control is one of these, differing only in range and label. */
function Slider({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void }) {
  return <label className="camera-raw-slider">
    <span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.valueAsNumber)} />
    <output>{value}</output>
  </label>;
}

export function CameraRawFilterDialog({ layer, language, onApply, onClose }: { layer: RasterLayer; language: Language; onApply(pixels: Uint8ClampedArray, label: string): void; onClose(): void }) {
  const [settings, setSettings] = useState<CameraRawFilterSettings>(defaultCameraRawFilterSettings);
  const [tab, setTab] = useState<Tab>("basic");
  const [preview, setPreview] = useState<{ pixels: Uint8ClampedArray; width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const source = useMemo(() => downsample(layer.pixels, layer.width, layer.height, 640), [layer.pixels, layer.width, layer.height]);
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
  const setHsl = (channel: HslChannelName, field: keyof CameraRawFilterSettings["hsl"][HslChannelName], value: number) =>
    setSettings((current) => ({ ...current, hsl: { ...current.hsl, [channel]: { ...current.hsl[channel], [field]: value } } }));

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
          <nav className="camera-raw-filter-tabs">
            <button className={tab === "basic" ? "active" : ""} onClick={() => setTab("basic")}>{t("Basic", "Основное")}</button>
            <button className={tab === "curve" ? "active" : ""} onClick={() => setTab("curve")}>{t("Tone Curve", "Тоновая кривая")}</button>
            <button className={tab === "detail" ? "active" : ""} onClick={() => setTab("detail")}>{t("Detail", "Детализация")}</button>
            <button className={tab === "hsl" ? "active" : ""} onClick={() => setTab("hsl")}>{t("HSL / Color", "Цвет HSL")}</button>
            <button className={tab === "effects" ? "active" : ""} onClick={() => setTab("effects")}>{t("Effects", "Эффекты")}</button>
          </nav>
          {tab === "basic" && <div className="camera-raw-filter-panel">
            <strong>{t("White Balance", "Баланс белого")}</strong>
            <Slider label={t("Temperature", "Температура")} value={settings.temperature} min={-100} max={100} onChange={(value) => set("temperature", value)} />
            <Slider label={t("Tint", "Оттенок")} value={settings.tint} min={-100} max={100} onChange={(value) => set("tint", value)} />
            <strong>{t("Tone", "Тон")}</strong>
            <Slider label={t("Exposure", "Экспозиция")} value={settings.exposure} min={-5} max={5} step={0.05} onChange={(value) => set("exposure", value)} />
            <Slider label={t("Contrast", "Контраст")} value={settings.contrast} min={-100} max={100} onChange={(value) => set("contrast", value)} />
            <Slider label={t("Highlights", "Света")} value={settings.highlights} min={-100} max={100} onChange={(value) => set("highlights", value)} />
            <Slider label={t("Shadows", "Тени")} value={settings.shadows} min={-100} max={100} onChange={(value) => set("shadows", value)} />
            <Slider label={t("Whites", "Белые")} value={settings.whites} min={-100} max={100} onChange={(value) => set("whites", value)} />
            <Slider label={t("Blacks", "Чёрные")} value={settings.blacks} min={-100} max={100} onChange={(value) => set("blacks", value)} />
            <strong>{t("Presence", "Выразительность")}</strong>
            <Slider label={t("Texture", "Текстура")} value={settings.texture} min={-100} max={100} onChange={(value) => set("texture", value)} />
            <Slider label={t("Clarity", "Чёткость")} value={settings.clarity} min={-100} max={100} onChange={(value) => set("clarity", value)} />
            <Slider label={t("Dehaze", "Удаление дымки")} value={settings.dehaze} min={-100} max={100} onChange={(value) => set("dehaze", value)} />
            <Slider label={t("Vibrance", "Вибрация")} value={settings.vibrance} min={-100} max={100} onChange={(value) => set("vibrance", value)} />
            <Slider label={t("Saturation", "Насыщенность")} value={settings.saturation} min={-100} max={100} onChange={(value) => set("saturation", value)} />
          </div>}
          {tab === "curve" && <div className="camera-raw-filter-panel">
            <strong>{t("Parametric Curve", "Параметрическая кривая")}</strong>
            <Slider label={t("Highlights", "Света")} value={settings.curveHighlights} min={-100} max={100} onChange={(value) => set("curveHighlights", value)} />
            <Slider label={t("Lights", "Светлые тона")} value={settings.curveLights} min={-100} max={100} onChange={(value) => set("curveLights", value)} />
            <Slider label={t("Darks", "Тёмные тона")} value={settings.curveDarks} min={-100} max={100} onChange={(value) => set("curveDarks", value)} />
            <Slider label={t("Shadows", "Тени")} value={settings.curveShadows} min={-100} max={100} onChange={(value) => set("curveShadows", value)} />
          </div>}
          {tab === "detail" && <div className="camera-raw-filter-panel">
            <strong>{t("Sharpening", "Резкость")}</strong>
            <Slider label={t("Amount", "Сила")} value={settings.sharpenAmount} min={0} max={150} onChange={(value) => set("sharpenAmount", value)} />
            <Slider label={t("Radius", "Радиус")} value={settings.sharpenRadius} min={0.5} max={3} step={0.1} onChange={(value) => set("sharpenRadius", value)} />
            <Slider label={t("Detail", "Детализация")} value={settings.sharpenDetail} min={0} max={100} onChange={(value) => set("sharpenDetail", value)} />
            <Slider label={t("Masking", "Маскирование")} value={settings.sharpenMasking} min={0} max={100} onChange={(value) => set("sharpenMasking", value)} />
            <strong>{t("Noise Reduction", "Уменьшение шума")}</strong>
            <Slider label={t("Luminance", "Яркость")} value={settings.noiseLuminance} min={0} max={100} onChange={(value) => set("noiseLuminance", value)} />
            <Slider label={t("Color", "Цвет")} value={settings.noiseColor} min={0} max={100} onChange={(value) => set("noiseColor", value)} />
          </div>}
          {tab === "hsl" && <div className="camera-raw-filter-panel camera-raw-hsl">
            {hslChannels.map(({ key, en, ru, swatch }) => <div className="camera-raw-hsl-channel" key={key}>
              <strong><i style={{ background: swatch }} />{t(en, ru)}</strong>
              <Slider label={t("Hue", "Тон")} value={settings.hsl[key].hue} min={-100} max={100} onChange={(value) => setHsl(key, "hue", value)} />
              <Slider label={t("Saturation", "Насыщенность")} value={settings.hsl[key].saturation} min={-100} max={100} onChange={(value) => setHsl(key, "saturation", value)} />
              <Slider label={t("Luminance", "Яркость")} value={settings.hsl[key].luminance} min={-100} max={100} onChange={(value) => setHsl(key, "luminance", value)} />
            </div>)}
          </div>}
          {tab === "effects" && <div className="camera-raw-filter-panel">
            <strong>{t("Vignette", "Виньетка")}</strong>
            <Slider label={t("Amount", "Сила")} value={settings.vignetteAmount} min={-100} max={100} onChange={(value) => set("vignetteAmount", value)} />
            <Slider label={t("Midpoint", "Средняя точка")} value={settings.vignetteMidpoint} min={0} max={100} onChange={(value) => set("vignetteMidpoint", value)} />
            <Slider label={t("Roundness", "Округлость")} value={settings.vignetteRoundness} min={-100} max={100} onChange={(value) => set("vignetteRoundness", value)} />
            <Slider label={t("Feather", "Растушёвка")} value={settings.vignetteFeather} min={0} max={100} onChange={(value) => set("vignetteFeather", value)} />
            <strong>{t("Grain", "Зерно")}</strong>
            <Slider label={t("Amount", "Сила")} value={settings.grainAmount} min={0} max={100} onChange={(value) => set("grainAmount", value)} />
            <Slider label={t("Size", "Размер")} value={settings.grainSize} min={0} max={100} onChange={(value) => set("grainSize", value)} />
            <Slider label={t("Roughness", "Неровность")} value={settings.grainRoughness} min={0} max={100} onChange={(value) => set("grainRoughness", value)} />
          </div>}
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
