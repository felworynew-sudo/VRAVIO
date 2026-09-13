import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { brushPresets } from "./assets-library/brushes/registry";
import type { BrushPreset } from "./assets-library/brushes/types";
import { resolveLabel, text } from "./i18n";
import { useShellStore, type Language } from "./store";

type BrushSectionId = "tip" | "shape" | "scatter" | "texture" | "dual" | "color" | "transfer" | "pose" | "noise" | "wetEdges" | "buildUp" | "smoothing" | "protectTexture";

interface BrushSection {
  readonly id: BrushSectionId;
  readonly en: string;
  readonly ru: string;
  readonly configurable?: boolean;
}

const brushSections: readonly BrushSection[] = [
  { id: "tip", en: "Brush Tip Shape", ru: "Форма отпечатка кисти", configurable: true },
  { id: "shape", en: "Shape Dynamics", ru: "Динамика формы", configurable: true },
  { id: "scatter", en: "Scattering", ru: "Рассеивание", configurable: true },
  { id: "texture", en: "Texture", ru: "Текстура", configurable: true },
  { id: "dual", en: "Dual Brush", ru: "Двойная кисть", configurable: true },
  { id: "color", en: "Color Dynamics", ru: "Динамика цвета", configurable: true },
  { id: "transfer", en: "Transfer", ru: "Передача", configurable: true },
  { id: "pose", en: "Brush Pose", ru: "Положение кисти", configurable: true },
  { id: "noise", en: "Noise", ru: "Шум" },
  { id: "wetEdges", en: "Wet Edges", ru: "Влажные края" },
  { id: "buildUp", en: "Build-up", ru: "Накладка" },
  { id: "smoothing", en: "Smoothing", ru: "Сглаживание" },
  { id: "protectTexture", en: "Protect Texture", ru: "Защита текстуры" },
];

type DraftValues = Record<string, number | boolean | string>;

// Zustand selectors must return a stable fallback value. Returning a new object
// here on every store read makes useSyncExternalStore believe the snapshot has
// changed continuously when no brush settings have been saved yet.
const emptyBrushToolOptions: Readonly<Record<string, string | number | boolean>> = {};

const initialDraft: DraftValues = {
  sizeJitter: 0, minimumDiameter: 0, angleJitter: 0, roundnessJitter: 0, minimumRoundness: 0,
  scatter: 0, bothAxes: false, count: 1, countJitter: 0,
  textureScale: 100, textureBrightness: 0, textureContrast: 0, textureEachTip: true, textureDepth: 100, textureDepthJitter: 0,
  dualSize: 25, dualSpacing: 25, dualScatter: 0, dualCount: 1,
  foregroundBackgroundJitter: 0, hueJitter: 0, saturationJitter: 0, brightnessJitter: 0, purity: 0, applyPerTip: false,
  opacityJitter: 0, minimumOpacity: 0, flowJitter: 0, minimumFlow: 0,
  tiltX: 0, tiltY: 0, rotation: 0, pressure: 100,
};

const controlOptions = ["Off", "Pen pressure", "Pen tilt", "Fade", "Direction"] as const;

function NumberField({ label, value, min = 0, max = 100, unit = "%", onChange }: { label: string; value: number; min?: number; max?: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="brush-setting-field">
    <span>{label}</span>
    <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(event.currentTarget.valueAsNumber)} />
    <output>{value}{unit}</output>
  </label>;
}

function ControlField({ language }: { language: Language }) {
  return <label className="brush-setting-control"><span>{text(language, "Control", "Управление")}</span><select defaultValue="Off">{controlOptions.map((value) => <option key={value}>{text(language, value, value === "Off" ? "Выкл" : value === "Pen pressure" ? "Нажим пера" : value === "Pen tilt" ? "Наклон пера" : value === "Fade" ? "Угасание" : "Направление")}</option>)}</select></label>;
}

function BrushStrokePreview({ hardness, roundness }: { hardness: number; roundness: number }) {
  return <div className="brush-stroke-preview" aria-label="Brush stroke preview">
    <svg viewBox="0 0 320 76" role="img" aria-hidden="true" preserveAspectRatio="none">
      <path d="M14 48 C58 17, 105 18, 154 38 S250 65, 306 27" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={Math.max(2, 2 + roundness / 32)} opacity={Math.max(.35, hardness / 100)} />
    </svg>
  </div>;
}

export function BrushSettingsPanel() {
  const language = useShellStore((state) => state.language);
  const toolOptions = useShellStore((state) => state.toolOptions["raster.brush"] ?? emptyBrushToolOptions);
  const setToolOption = useShellStore((state) => state.setToolOption);
  const [selected, setSelected] = useState<BrushSectionId>("tip");
  const [enabled, setEnabled] = useState<Set<BrushSectionId>>(() => new Set(["shape", "scatter", "texture", "smoothing"]));
  const [locked, setLocked] = useState<Set<BrushSectionId>>(() => new Set());
  // Settings panel fields write into the same brush option set the paint tool
  // reads. Keeping a separate draft here made the UI look configured while a
  // stroke silently continued using its old behaviour.
  const setDraftValue = (key: string, value: number | boolean | string) => setToolOption("raster.brush", key, value);
  const value = (id: "size" | "hardness" | "spacing" | "roundness" | "angle", fallback: number) => Number(toolOptions[id] ?? fallback);
  const section = brushSections.find((entry) => entry.id === selected)!;
  const selectSection = (id: BrushSectionId) => setSelected(id);
  const toggleEnabled = (id: BrushSectionId) => setEnabled((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const toggleLocked = (id: BrushSectionId) => setLocked((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const liveValue = (id: "size" | "hardness" | "spacing" | "roundness" | "angle", fallback: number) => value(id, fallback);

  const draftField = (key: string, label: string, options: { min?: number; max?: number; unit?: string } = {}) => <NumberField label={label} value={Number(toolOptions[key] ?? initialDraft[key])} onChange={(next) => setDraftValue(key, next)} {...options} />;
  const checkbox = (key: string, label: string) => <label className="brush-inline-checkbox"><input type="checkbox" checked={Boolean(toolOptions[key] ?? initialDraft[key])} onChange={(event) => setDraftValue(key, event.currentTarget.checked)} />{label}</label>;

  let editor: ReactNode;
  if (selected === "tip") editor = <>
    <div className="brush-tip-geometry">
      <div className="brush-tip-swatch" style={{ "--brush-roundness": `${liveValue("roundness", 100)}%`, "--brush-angle": `${liveValue("angle", 0)}deg`, "--brush-hardness": `${liveValue("hardness", 82)}%` } as CSSProperties} />
      <div className="brush-tip-flips">{checkbox("flipX", text(language, "Flip X", "Отразить X"))}{checkbox("flipY", text(language, "Flip Y", "Отразить Y"))}</div>
    </div>
    <NumberField label={text(language, "Size", "Размер")} value={liveValue("size", 24)} min={1} max={1000} unit=" px" onChange={(next) => setToolOption("raster.brush", "size", next)} />
    <NumberField label={text(language, "Angle", "Угол")} value={liveValue("angle", 0)} min={-180} max={180} unit="°" onChange={(next) => setToolOption("raster.brush", "angle", next)} />
    <NumberField label={text(language, "Roundness", "Округлость")} value={liveValue("roundness", 100)} min={1} max={100} onChange={(next) => setToolOption("raster.brush", "roundness", next)} />
    <NumberField label={text(language, "Hardness", "Жёсткость")} value={liveValue("hardness", 82)} min={0} max={100} onChange={(next) => setToolOption("raster.brush", "hardness", next)} />
    <NumberField label={text(language, "Spacing", "Интервалы")} value={liveValue("spacing", 12)} min={1} max={300} onChange={(next) => setToolOption("raster.brush", "spacing", next)} />
  </>;
  else if (selected === "shape") editor = <>
    {draftField("sizeJitter", text(language, "Size Jitter", "Колебание размера"))}<ControlField language={language} />
    {draftField("minimumDiameter", text(language, "Minimum Diameter", "Минимальный диаметр"))}
    {draftField("angleJitter", text(language, "Angle Jitter", "Колебание угла"))}<ControlField language={language} />
    {draftField("roundnessJitter", text(language, "Roundness Jitter", "Колебание формы"))}<ControlField language={language} />
    {draftField("minimumRoundness", text(language, "Minimum Roundness", "Минимальная форма"))}
    <div className="brush-inline-row">{checkbox("flipXJitter", text(language, "Flip X Jitter", "Отразить X колебания"))}{checkbox("flipYJitter", text(language, "Flip Y Jitter", "Отразить Y колебания"))}</div>
    {checkbox("projection", text(language, "Brush Projection", "Проекция кисти"))}
  </>;
  else if (selected === "scatter") editor = <>
    <div className="brush-inline-row">{checkbox("bothAxes", text(language, "Both Axes", "Обе оси"))}</div>
    {draftField("scatter", text(language, "Scatter", "Рассеивание"), { max: 1000 })}<ControlField language={language} />
    {draftField("count", text(language, "Count", "Счётчик"), { min: 1, max: 16, unit: "" })}
    {draftField("countJitter", text(language, "Count Jitter", "Колебание счётчика"))}<ControlField language={language} />
  </>;
  else if (selected === "texture") editor = <>
    <button className="brush-pattern-select" type="button"><span className="brush-pattern-sample" />{text(language, "Choose pattern", "Выбрать текстуру")}</button>
    <div className="brush-inline-row">{checkbox("invertTexture", text(language, "Invert", "Инвертировать"))}{checkbox("textureEachTip", text(language, "Texture Each Tip", "Текстурировать каждый отпечаток"))}</div>
    {draftField("textureScale", text(language, "Scale", "Шкала"))}{draftField("textureBrightness", text(language, "Brightness", "Яркость"), { min: -100, max: 100 })}{draftField("textureContrast", text(language, "Contrast", "Контрастность"), { min: -100, max: 100 })}
    <ControlField language={language} />{draftField("textureDepth", text(language, "Depth", "Глубина"))}{draftField("textureDepthJitter", text(language, "Depth Jitter", "Колебание глубины"))}
  </>;
  else if (selected === "dual") editor = <>
    <label className="brush-setting-control"><span>{text(language, "Mode", "Режим")}</span><select defaultValue="Darken"><option>{text(language, "Darken", "Затемнение основы")}</option></select></label>
    <div className="brush-dual-tip-grid" aria-label={text(language, "Secondary brush tips", "Вторичные наконечники")}>{Array.from({ length: 12 }, (_, index) => <button key={index} type="button" className={index === 2 ? "selected" : ""}><span className={`brush-preset-mark variant-${index % 4}`} /></button>)}</div>
    {draftField("dualSize", text(language, "Size", "Размер"), { min: 1, max: 1000, unit: " px" })}{draftField("dualSpacing", text(language, "Spacing", "Интервалы"))}{draftField("dualScatter", text(language, "Scatter", "Рассеивание"))}{draftField("dualCount", text(language, "Count", "Счётчик"), { min: 1, max: 16, unit: "" })}
  </>;
  else if (selected === "color") editor = <>
    {checkbox("applyPerTip", text(language, "Apply Per Tip", "Применить для кончика"))}
    {draftField("foregroundBackgroundJitter", text(language, "Foreground/Background Jitter", "Колебание переднего/заднего плана"))}<ControlField language={language} />
    {draftField("hueJitter", text(language, "Hue Jitter", "Колебание цветового тона"))}{draftField("saturationJitter", text(language, "Saturation Jitter", "Колебание насыщенности"))}{draftField("brightnessJitter", text(language, "Brightness Jitter", "Колебание яркости"))}{draftField("purity", text(language, "Purity", "Чистота"), { min: -100, max: 100 })}
  </>;
  else if (selected === "transfer") editor = <>
    {draftField("opacityJitter", text(language, "Opacity Jitter", "Колебание непрозрачности"))}<ControlField language={language} />{draftField("minimumOpacity", text(language, "Minimum", "Минимальное"))}
    {draftField("flowJitter", text(language, "Flow Jitter", "Колебание количества краски"))}<ControlField language={language} />{draftField("minimumFlow", text(language, "Minimum", "Минимальное"))}
  </>;
  else if (selected === "pose") editor = <>
    {draftField("tiltX", text(language, "Tilt X", "Наклон по оси X"), { min: -100, max: 100 })}{checkbox("overrideTiltX", text(language, "Override Tilt X", "Переопределить наклон по оси X"))}
    {draftField("tiltY", text(language, "Tilt Y", "Наклон по оси Y"), { min: -100, max: 100 })}{checkbox("overrideTiltY", text(language, "Override Tilt Y", "Переопределить наклон по оси Y"))}
    {draftField("rotation", text(language, "Rotation", "Поворот"), { min: -180, max: 180, unit: "°" })}{checkbox("overrideRotation", text(language, "Override Rotation", "Переопределить поворот"))}
    {draftField("pressure", text(language, "Pressure", "Нажим"))}{checkbox("overridePressure", text(language, "Override Pressure", "Переопределить нажим"))}
  </>;
  else editor = <div className="brush-simple-setting"><strong>{text(language, section.en, section.ru)}</strong><p>{text(language, "This section is a single preset switch, with no extra parameters.", "У этого раздела только переключатель участия в пресете, без дополнительных параметров.")}</p></div>;

  return <div className="brush-settings-panel">
    <div className="brush-settings-nav" role="tablist" aria-label={text(language, "Brush Settings", "Настройки кисти")}>
      {brushSections.map((entry) => <div key={entry.id} className={`brush-settings-nav-row${selected === entry.id ? " selected" : ""}${!entry.configurable ? " simple" : ""}`}>
        <input aria-label={text(language, `Enable ${entry.en}`, `Включить ${entry.ru}`)} type="checkbox" checked={entry.id === "tip" || enabled.has(entry.id)} disabled={entry.id === "tip"} onChange={() => toggleEnabled(entry.id)} />
        <button type="button" role="tab" aria-selected={selected === entry.id} onClick={() => selectSection(entry.id)}>{text(language, entry.en, entry.ru)}</button>
        <button type="button" className={`brush-settings-lock${locked.has(entry.id) ? " locked" : ""}`} aria-label={text(language, "Lock setting", "Закрепить настройку")} aria-pressed={locked.has(entry.id)} onClick={() => toggleLocked(entry.id)} />
      </div>)}
    </div>
    <div className="brush-settings-editor" role="tabpanel">
      <h3>{text(language, section.en, section.ru)}</h3>
      {editor}
    </div>
    <BrushStrokePreview hardness={liveValue("hardness", 82)} roundness={liveValue("roundness", 100)} />
  </div>;
}

interface StoredBrushPreset extends BrushPreset { readonly custom?: boolean }
const CUSTOM_PRESETS_KEY = "vravio.brush-presets.custom.v1";

function readCustomPresets(): StoredBrushPreset[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is StoredBrushPreset => Boolean(entry) && typeof entry === "object" && typeof (entry as StoredBrushPreset).id === "string" && typeof (entry as StoredBrushPreset).label?.en === "string" && typeof (entry as StoredBrushPreset).options === "object");
  } catch { return []; }
}

function presetShape(preset: BrushPreset): string {
  if (preset.id === "calligraphy") return "flat";
  return preset.id === "soft-round" ? "soft" : "round";
}

export function BrushesPanel() {
  const language = useShellStore((state) => state.language);
  const setTool = useShellStore((state) => state.setTool);
  const setToolOption = useShellStore((state) => state.setToolOption);
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const brushOptions = useShellStore((state) => state.toolOptions["raster.brush"] ?? emptyBrushToolOptions);
  const [query, setQuery] = useState("");
  const [customPresets, setCustomPresets] = useState<StoredBrushPreset[]>(readCustomPresets);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const allPresets = useMemo<readonly StoredBrushPreset[]>(() => [...brushPresets, ...customPresets], [customPresets]);
  const visiblePresets = allPresets.filter((preset) => resolveLabel(preset.label, language).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectPreset = (preset: StoredBrushPreset) => {
    if (activeDocumentId) setTool(activeDocumentId, "raster.brush");
    for (const [id, value] of Object.entries(preset.options)) setToolOption("raster.brush", id, value);
    setRecentIds((current) => [preset.id, ...current.filter((id) => id !== preset.id)].slice(0, 6));
  };
  const addPreset = () => {
    const name = window.prompt(text(language, "Name the brush preset", "Название пресета кисти"));
    if (!name?.trim()) return;
    const preset: StoredBrushPreset = {
      id: `custom-${Date.now().toString(36)}`,
      label: { en: name.trim(), ru: name.trim() }, glyph: "●", order: 1000 + customPresets.length,
      // A preset is the current brush behaviour, not merely the five fields
      // visible in the compact options bar. Unknown future fields remain
      // serialisable, making saved presets forward-compatible.
      options: { ...brushOptions },
      custom: true,
    };
    setCustomPresets((current) => { const next = [...current, preset]; localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(next)); return next; });
  };
  const recent = recentIds.map((id) => allPresets.find((preset) => preset.id === id)).filter((preset): preset is StoredBrushPreset => Boolean(preset));

  return <div className="brush-library-panel">
    <div className="brush-library-size"><label>{text(language, "Size", "Размер")}</label><input type="range" min="1" max="1000" value={Number(brushOptions.size ?? 24)} onChange={(event) => setToolOption("raster.brush", "size", event.currentTarget.valueAsNumber)} /><output>{Number(brushOptions.size ?? 24)} px</output></div>
    <input className="panel-search" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={text(language, "Search Brushes", "Поиск кистей")} />
    {recent.length > 0 && <section className="brush-library-recent"><h3>{text(language, "Recent", "Недавние")}</h3><div className="brush-recent-strip">{recent.map((preset) => <button key={preset.id} type="button" onClick={() => selectPreset(preset)} title={resolveLabel(preset.label, language)}><span className={`brush-preset-mark ${presetShape(preset)}`} /></button>)}</div></section>}
    <section className="brush-library-group"><header><span className="brush-library-folder" />{text(language, "Basic Brushes", "Основные кисти")}</header><div className="brush-preset-grid">{visiblePresets.map((preset) => <button key={preset.id} type="button" className="brush-preset-card" onClick={() => selectPreset(preset)}><span className={`brush-preset-mark ${presetShape(preset)}`} /><span>{resolveLabel(preset.label, language)}</span></button>)}</div></section>
    <section className="brush-library-group collapsed"><header><span className="brush-library-folder" />{text(language, "Dry Brushes", "Сухие кисти")}</header></section>
    <section className="brush-library-group collapsed"><header><span className="brush-library-folder" />{text(language, "Wet Brushes", "Мокрые кисти")}</header></section>
    <section className="brush-library-group collapsed"><header><span className="brush-library-folder" />{text(language, "Special Effect Brushes", "Кисти со специальными эффектами")}</header></section>
    <footer className="brush-library-footer"><button type="button" onClick={addPreset}>{text(language, "New brush preset", "Новый пресет кисти")}</button><span>{text(language, "Saved locally", "Сохранено локально")}</span></footer>
  </div>;
}
