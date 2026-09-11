import type { CameraRawFilterSettings, HslChannelName } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";

/** Shared by the RAW-import dialog and Filter > Camera Raw Filter — Photoshop's two entry points
 * into the same develop panel (`camera-raw-filter.ts`'s own doc comment already calls these "the
 * two halves of one feature"). One panel, not two copies that drift apart (CLAUDE.md §4). */

const hslChannels: { key: HslChannelName; en: string; ru: string; swatch: string }[] = [
  { key: "red", en: "Red", ru: "Красный", swatch: "#e5484d" }, { key: "orange", en: "Orange", ru: "Оранжевый", swatch: "#f76b15" },
  { key: "yellow", en: "Yellow", ru: "Жёлтый", swatch: "#ffe629" }, { key: "green", en: "Green", ru: "Зелёный", swatch: "#30a46c" },
  { key: "aqua", en: "Aqua", ru: "Бирюзовый", swatch: "#12a594" }, { key: "blue", en: "Blue", ru: "Синий", swatch: "#0090ff" },
  { key: "purple", en: "Purple", ru: "Фиолетовый", swatch: "#8e4ec6" }, { key: "magenta", en: "Magenta", ru: "Пурпурный", swatch: "#d6409f" },
];

export type CameraRawTab = "basic" | "curve" | "detail" | "hsl" | "effects";

function Slider({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void }) {
  return <label className="camera-raw-slider">
    <span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.valueAsNumber)} />
    <output>{value}</output>
  </label>;
}

export function CameraRawTabs({ tab, onChange, language }: { tab: CameraRawTab; onChange(tab: CameraRawTab): void; language: Language }) {
  const t = (en: string, ru: string) => text(language, en, ru);
  const tabs: { key: CameraRawTab; en: string; ru: string }[] = [
    { key: "basic", en: "Basic", ru: "Основное" }, { key: "curve", en: "Tone Curve", ru: "Тоновая кривая" },
    { key: "detail", en: "Detail", ru: "Детализация" }, { key: "hsl", en: "HSL / Color", ru: "Цвет HSL" },
    { key: "effects", en: "Effects", ru: "Эффекты" },
  ];
  return <nav className="camera-raw-filter-tabs">
    {tabs.map(({ key, en, ru }) => <button key={key} className={tab === key ? "active" : ""} onClick={() => onChange(key)}>{t(en, ru)}</button>)}
  </nav>;
}

export function CameraRawPanel({ tab, settings, language, onChange }: { tab: CameraRawTab; settings: CameraRawFilterSettings; language: Language; onChange<K extends keyof CameraRawFilterSettings>(key: K, value: CameraRawFilterSettings[K]): void }) {
  const t = (en: string, ru: string) => text(language, en, ru);
  const setHsl = (channel: HslChannelName, field: keyof CameraRawFilterSettings["hsl"][HslChannelName], value: number) =>
    onChange("hsl", { ...settings.hsl, [channel]: { ...settings.hsl[channel], [field]: value } });

  if (tab === "basic") return <div className="camera-raw-filter-panel">
    <strong>{t("White Balance", "Баланс белого")}</strong>
    <Slider label={t("Temperature", "Температура")} value={settings.temperature} min={-100} max={100} onChange={(value) => onChange("temperature", value)} />
    <Slider label={t("Tint", "Оттенок")} value={settings.tint} min={-100} max={100} onChange={(value) => onChange("tint", value)} />
    <strong>{t("Tone", "Тон")}</strong>
    <Slider label={t("Exposure", "Экспозиция")} value={settings.exposure} min={-5} max={5} step={0.05} onChange={(value) => onChange("exposure", value)} />
    <Slider label={t("Contrast", "Контраст")} value={settings.contrast} min={-100} max={100} onChange={(value) => onChange("contrast", value)} />
    <Slider label={t("Highlights", "Света")} value={settings.highlights} min={-100} max={100} onChange={(value) => onChange("highlights", value)} />
    <Slider label={t("Shadows", "Тени")} value={settings.shadows} min={-100} max={100} onChange={(value) => onChange("shadows", value)} />
    <Slider label={t("Whites", "Белые")} value={settings.whites} min={-100} max={100} onChange={(value) => onChange("whites", value)} />
    <Slider label={t("Blacks", "Чёрные")} value={settings.blacks} min={-100} max={100} onChange={(value) => onChange("blacks", value)} />
    <strong>{t("Presence", "Выразительность")}</strong>
    <Slider label={t("Texture", "Текстура")} value={settings.texture} min={-100} max={100} onChange={(value) => onChange("texture", value)} />
    <Slider label={t("Clarity", "Чёткость")} value={settings.clarity} min={-100} max={100} onChange={(value) => onChange("clarity", value)} />
    <Slider label={t("Dehaze", "Удаление дымки")} value={settings.dehaze} min={-100} max={100} onChange={(value) => onChange("dehaze", value)} />
    <Slider label={t("Vibrance", "Вибрация")} value={settings.vibrance} min={-100} max={100} onChange={(value) => onChange("vibrance", value)} />
    <Slider label={t("Saturation", "Насыщенность")} value={settings.saturation} min={-100} max={100} onChange={(value) => onChange("saturation", value)} />
  </div>;

  if (tab === "curve") return <div className="camera-raw-filter-panel">
    <strong>{t("Parametric Curve", "Параметрическая кривая")}</strong>
    <Slider label={t("Highlights", "Света")} value={settings.curveHighlights} min={-100} max={100} onChange={(value) => onChange("curveHighlights", value)} />
    <Slider label={t("Lights", "Светлые тона")} value={settings.curveLights} min={-100} max={100} onChange={(value) => onChange("curveLights", value)} />
    <Slider label={t("Darks", "Тёмные тона")} value={settings.curveDarks} min={-100} max={100} onChange={(value) => onChange("curveDarks", value)} />
    <Slider label={t("Shadows", "Тени")} value={settings.curveShadows} min={-100} max={100} onChange={(value) => onChange("curveShadows", value)} />
  </div>;

  if (tab === "detail") return <div className="camera-raw-filter-panel">
    <strong>{t("Sharpening", "Резкость")}</strong>
    <Slider label={t("Amount", "Сила")} value={settings.sharpenAmount} min={0} max={150} onChange={(value) => onChange("sharpenAmount", value)} />
    <Slider label={t("Radius", "Радиус")} value={settings.sharpenRadius} min={0.5} max={3} step={0.1} onChange={(value) => onChange("sharpenRadius", value)} />
    <Slider label={t("Detail", "Детализация")} value={settings.sharpenDetail} min={0} max={100} onChange={(value) => onChange("sharpenDetail", value)} />
    <Slider label={t("Masking", "Маскирование")} value={settings.sharpenMasking} min={0} max={100} onChange={(value) => onChange("sharpenMasking", value)} />
    <strong>{t("Noise Reduction", "Уменьшение шума")}</strong>
    <Slider label={t("Luminance", "Яркость")} value={settings.noiseLuminance} min={0} max={100} onChange={(value) => onChange("noiseLuminance", value)} />
    <Slider label={t("Color", "Цвет")} value={settings.noiseColor} min={0} max={100} onChange={(value) => onChange("noiseColor", value)} />
  </div>;

  if (tab === "hsl") return <div className="camera-raw-filter-panel camera-raw-hsl">
    {hslChannels.map(({ key, en, ru, swatch }) => <div className="camera-raw-hsl-channel" key={key}>
      <strong><i style={{ background: swatch }} />{t(en, ru)}</strong>
      <Slider label={t("Hue", "Тон")} value={settings.hsl[key].hue} min={-100} max={100} onChange={(value) => setHsl(key, "hue", value)} />
      <Slider label={t("Saturation", "Насыщенность")} value={settings.hsl[key].saturation} min={-100} max={100} onChange={(value) => setHsl(key, "saturation", value)} />
      <Slider label={t("Luminance", "Яркость")} value={settings.hsl[key].luminance} min={-100} max={100} onChange={(value) => setHsl(key, "luminance", value)} />
    </div>)}
  </div>;

  return <div className="camera-raw-filter-panel">
    <strong>{t("Vignette", "Виньетка")}</strong>
    <Slider label={t("Amount", "Сила")} value={settings.vignetteAmount} min={-100} max={100} onChange={(value) => onChange("vignetteAmount", value)} />
    <Slider label={t("Midpoint", "Средняя точка")} value={settings.vignetteMidpoint} min={0} max={100} onChange={(value) => onChange("vignetteMidpoint", value)} />
    <Slider label={t("Roundness", "Округлость")} value={settings.vignetteRoundness} min={-100} max={100} onChange={(value) => onChange("vignetteRoundness", value)} />
    <Slider label={t("Feather", "Растушёвка")} value={settings.vignetteFeather} min={0} max={100} onChange={(value) => onChange("vignetteFeather", value)} />
    <strong>{t("Grain", "Зерно")}</strong>
    <Slider label={t("Amount", "Сила")} value={settings.grainAmount} min={0} max={100} onChange={(value) => onChange("grainAmount", value)} />
    <Slider label={t("Size", "Размер")} value={settings.grainSize} min={0} max={100} onChange={(value) => onChange("grainSize", value)} />
    <Slider label={t("Roughness", "Неровность")} value={settings.grainRoughness} min={0} max={100} onChange={(value) => onChange("grainRoughness", value)} />
  </div>;
}
