import { useMemo, useState, type CSSProperties } from "react";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { environmentMeta } from "./environment";
import { text } from "./i18n";
import { useShellStore } from "./store";

type Unit = "px" | "mm" | "cm" | "in";
type PresetCategory = "recent" | "photo" | "print" | "art" | "web" | "mobile" | "video";
interface Preset { id: string; name: string; category: Exclude<PresetCategory, "recent">; width: number; height: number; resolution: number }

const presets: readonly Preset[] = [
  { id: "web-hd", name: "Web 1920 × 1080", category: "web", width: 1920, height: 1080, resolution: 72 },
  { id: "web-common", name: "Web 1366 × 768", category: "web", width: 1366, height: 768, resolution: 72 },
  { id: "square-1000", name: "Square 1000 (Квадрат 1000)", category: "art", width: 1000, height: 1000, resolution: 72 },
  { id: "square-2000", name: "Square 2000 (Квадрат 2000)", category: "art", width: 2000, height: 2000, resolution: 72 },
  { id: "photo-4x6", name: "Photo 4 × 6 (Фото 4 × 6)", category: "photo", width: 1200, height: 1800, resolution: 300 },
  { id: "a4", name: "A4 · 300 ppi", category: "print", width: 2480, height: 3508, resolution: 300 },
  { id: "mobile-1080", name: "Android 1080p", category: "mobile", width: 1080, height: 1920, resolution: 72 },
  { id: "hdtv", name: "HDTV 1080p", category: "video", width: 1920, height: 1080, resolution: 72 },
  { id: "uhd", name: "UHD 4K", category: "video", width: 3840, height: 2160, resolution: 72 },
];

function pixelsPerInch(resolution: number, unit: "ppi" | "ppcm"): number { return unit === "ppi" ? resolution : resolution * 2.54; }
function toPixels(value: number, unit: Unit, ppi: number): number { return unit === "px" ? value : value * ppi / (unit === "in" ? 1 : unit === "cm" ? 2.54 : 25.4); }
function fromPixels(value: number, unit: Unit, ppi: number): number { return unit === "px" ? value : value / ppi * (unit === "in" ? 1 : unit === "cm" ? 2.54 : 25.4); }

export function NewDocumentDialog() {
  const store = useShellStore();
  const kind = store.newDocumentKind;
  const language = store.language;
  const [category, setCategory] = useState<PresetCategory>("recent");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<Unit>("px");
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [resolution, setResolution] = useState(72);
  const [resolutionUnit, setResolutionUnit] = useState<"ppi" | "ppcm">("ppi");
  const [background, setBackground] = useState<"transparent" | "white" | "black" | "custom">("transparent");
  const [customBackground, setCustomBackground] = useState("#ffffff");
  const [pixelAspectRatio, setPixelAspectRatio] = useState(1);
  const [artboards, setArtboards] = useState(false);
  const [frameRate, setFrameRate] = useState(30);
  const [sampleRate, setSampleRate] = useState(48000);
  const [channels, setChannels] = useState(2);
  const [audioBitDepth, setAudioBitDepth] = useState(24);
  const shownPresets = useMemo(() => category === "recent" ? presets.slice(0, 5) : presets.filter((preset) => preset.category === category), [category]);
  if (!kind) return null;
  const meta = environmentMeta[kind];
  const valid = [width, height, resolution, pixelAspectRatio].every((value) => Number.isFinite(value) && value > 0);
  const ppi = pixelsPerInch(valid ? resolution : 72, resolutionUnit);
  const widthPx = valid ? Math.max(1, Math.min(32768, Math.round(toPixels(width, unit, ppi)))) : 0;
  const heightPx = valid ? Math.max(1, Math.min(32768, Math.round(toPixels(height, unit, ppi)))) : 0;
  const backgroundColor = background === "transparent" ? null : background === "white" ? "#ffffff" : background === "black" ? "#000000" : customBackground;

  const changeUnit = (next: Unit) => {
    const currentPpi = pixelsPerInch(resolution, resolutionUnit);
    const currentWidthPx = toPixels(width, unit, currentPpi), currentHeightPx = toPixels(height, unit, currentPpi);
    setUnit(next); setWidth(Number(fromPixels(currentWidthPx, next, currentPpi).toFixed(next === "px" ? 0 : 3))); setHeight(Number(fromPixels(currentHeightPx, next, currentPpi).toFixed(next === "px" ? 0 : 3)));
  };
  const applyPreset = (preset: Preset) => { setUnit("px"); setWidth(preset.width); setHeight(preset.height); setResolution(preset.resolution); setResolutionUnit("ppi"); };
  const create = () => store.openDocument(kind, { ...(name.trim() ? { name: name.trim() } : {}), width: widthPx, height: heightPx, resolution, resolutionUnit, backgroundColor, pixelAspectRatio, artboards, frameRate, sampleRate, channels, audioBitDepth });
  const environmentKinds = ["raster", "vector", "audio", "video"] as const;

  const categories: readonly [PresetCategory, string][] = [
    ["recent", text(language, "Recent", "Недавние")], ["photo", text(language, "Photo", "Фото")], ["print", text(language, "Print", "Печать")],
    ["art", text(language, "Art", "Иллюстрации")], ["web", "Web"], ["mobile", text(language, "Mobile", "Мобильные")], ["video", text(language, "Film & Video", "Фильм и видео")],
  ];

  return <div className="dialog-backdrop new-document-backdrop" onMouseDown={store.cancelNewDocument}>
    <section className="new-document-dialog" role="dialog" aria-modal="true" aria-labelledby="new-document-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div className="new-document-title"><EnvironmentIcon kind={kind} /><div><small>{text(language, "NEW DOCUMENT", "НОВЫЙ ДОКУМЕНТ")}</small><h2 id="new-document-title">{text(language, "Create", "Создать")} {language === "ru" ? meta.label.match(/\((.*)\)/)?.[1] ?? meta.label : meta.label.replace(/\s*\(.*\)$/, "")}</h2></div></div><button onClick={store.cancelNewDocument} aria-label={text(language, "Close", "Закрыть")}>×</button></header>
      <div className="new-document-environments" role="tablist" aria-label={text(language, "Document type", "Тип документа")}>{environmentKinds.map((environmentKind) => <button role="tab" aria-selected={kind === environmentKind} className={kind === environmentKind ? "active" : ""} data-kind={environmentKind} key={environmentKind} onClick={() => store.requestNewDocument(environmentKind)}><EnvironmentIcon kind={environmentKind}/><span>{language === "ru" ? environmentMeta[environmentKind].label.match(/\((.*)\)/)?.[1] ?? environmentMeta[environmentKind].label : environmentMeta[environmentKind].label.replace(/\s*\(.*\)$/, "")}</span></button>)}</div>
      <div className="new-document-body">
        <aside>{categories.map(([id, label]) => <button className={category === id ? "active" : ""} key={id} onClick={() => setCategory(id)}>{label}</button>)}</aside>
        <div className="preset-grid">{shownPresets.map((preset) => <button key={preset.id} onClick={() => applyPreset(preset)}><span className="preset-shape" style={{ aspectRatio: `${preset.width}/${preset.height}` }} /><strong>{preset.name}</strong><small>{preset.width} × {preset.height} px · {preset.resolution} ppi</small></button>)}</div>
        <div className="document-parameters">
          <label className="wide"><span>{text(language, "Name", "Название")}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={text(language, "Untitled", "Без имени")} /></label>
          <div className="parameter-pair"><label><span>{text(language, "Width", "Ширина")}</span><input type="number" min="0.001" value={width} onChange={(event) => setWidth(event.target.valueAsNumber)} /></label><label><span>{text(language, "Height", "Высота")}</span><input type="number" min="0.001" value={height} onChange={(event) => setHeight(event.target.valueAsNumber)} /></label></div>
          <div className="parameter-pair"><label><span>{text(language, "Units", "Единицы")}</span><select value={unit} onChange={(event) => changeUnit(event.target.value as Unit)}><option value="px">px</option><option value="mm">mm</option><option value="cm">cm</option><option value="in">in</option></select></label><label><span>{text(language, "Orientation", "Ориентация")}</span><button className="orientation-button" onClick={() => { setWidth(height); setHeight(width); }}>↔ {widthPx >= heightPx ? text(language, "Landscape", "Альбомная") : text(language, "Portrait", "Книжная")}</button></label></div>
          <div className="parameter-pair"><label><span>{text(language, "Resolution", "Разрешение")}</span><input type="number" min="1" max="2400" value={resolution} onChange={(event) => setResolution(event.target.valueAsNumber)} /></label><label><span>{text(language, "Resolution units", "Единицы разрешения")}</span><select value={resolutionUnit} onChange={(event) => setResolutionUnit(event.target.value as "ppi" | "ppcm")}><option value="ppi">ppi</option><option value="ppcm">ppcm</option></select></label></div>
          {kind === "video" && <div className="parameter-pair"><label><span>Frame rate (Частота кадров)</span><select value={frameRate} onChange={(event) => setFrameRate(Number(event.target.value))}><option value="23.976">23.976 fps</option><option value="24">24 fps</option><option value="25">25 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></label><label><span>Timeline (Таймлайн)</span><output>{widthPx} × {heightPx} · {frameRate} fps</output></label></div>}
          {kind === "audio" && <><div className="parameter-pair"><label><span>Sample rate (Частота дискретизации)</span><select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))}><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option><option value="96000">96 kHz</option><option value="192000">192 kHz</option></select></label><label><span>Channels (Каналы)</span><select value={channels} onChange={(event) => setChannels(Number(event.target.value))}><option value="1">Mono (Моно)</option><option value="2">Stereo (Стерео)</option></select></label></div><label className="wide"><span>Bit depth (Разрядность)</span><select value={audioBitDepth} onChange={(event) => setAudioBitDepth(Number(event.target.value))}><option value="16">16 bit</option><option value="24">24 bit</option><option value="32">32 bit float</option></select></label></>}
          <div className="parameter-pair"><label><span>{text(language, "Color mode", "Цветовой режим")}</span><select><option>RGB · sRGB · 8 bit</option><option disabled>RGB · 16 bit — planned</option><option disabled>RGB · 32 bit — planned</option><option disabled>CMYK — color pipeline required</option></select></label><label><span>{text(language, "Pixel aspect", "Пропорции пикселя")}</span><input type="number" min="0.1" max="10" step="0.001" value={pixelAspectRatio} onChange={(event) => setPixelAspectRatio(event.target.valueAsNumber)} /></label></div>
          <label className="wide"><span>{text(language, "Background", "Фон")}</span><span className="background-control"><select value={background} onChange={(event) => setBackground(event.target.value as typeof background)}><option value="transparent">{text(language, "Transparent", "Прозрачный")}</option><option value="white">{text(language, "White", "Белый")}</option><option value="black">{text(language, "Black", "Чёрный")}</option><option value="custom">{text(language, "Custom", "Свой")}</option></select>{background === "custom" && <input type="color" value={customBackground} onChange={(event) => setCustomBackground(event.target.value)} />}</span></label>
          {kind === "vector" && <label className="artboards-check"><input type="checkbox" checked={artboards} onChange={(event) => setArtboards(event.target.checked)} />{text(language, "Enable artboards", "Включить монтажные области")}</label>}
          <div className="document-summary">{valid ? <>{widthPx} × {heightPx} px · {(widthPx * heightPx * 4 / 1024 / 1024).toFixed(1)} MB {text(language, "base layer", "базовый слой")}</> : text(language, "Enter positive numeric values", "Введите положительные числовые значения")}</div>
        </div>
      </div>
      <footer><button onClick={store.cancelNewDocument}>{text(language, "Cancel", "Отмена")}</button><button className="primary" style={{ "--accent": `var(--${kind})`, "--accent-ink": kind === "audio" ? "#1a1204" : "#fff" } as CSSProperties} disabled={!valid} onClick={create}>{text(language, "Create", "Создать")}</button></footer>
    </section>
  </div>;
}
