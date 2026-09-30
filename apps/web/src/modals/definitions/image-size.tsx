import { useState } from "react";
import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";
import { ModalBackdrop } from "../ModalBackdrop";

export type ResampleMethod = "auto" | "mitchell" | "lanczos3" | "bicubic" | "nearest" | "bilinear";
type Unit = "px" | "percent" | "in" | "cm" | "mm";

export interface ImageSizeAnswer {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly resample: ResampleMethod | null;
}

interface ImageSizeProps {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly resolutionUnit: "ppi" | "ppcm";
  readonly bytesPerPixel: number;
  readonly onResolve: (answer: ImageSizeAnswer | null) => void;
}

/** Photoshop's Resample list, minus Preserve Details, which this build has no method for — a
 * menu entry that did the same as another would be the checkbox that does nothing (CLAUDE.md §3). */
const METHODS: readonly { id: ResampleMethod; en: string; ru: string }[] = [
  { id: "auto", en: "Automatic", ru: "Автоматически" },
  { id: "mitchell", en: "Bicubic Smoother (enlargement)", ru: "Бикубическая, плавнее (увеличение)" },
  { id: "lanczos3", en: "Bicubic Sharper (reduction)", ru: "Бикубическая, чётче (уменьшение)" },
  { id: "bicubic", en: "Bicubic (smooth gradients)", ru: "Бикубическая (плавные градиенты)" },
  { id: "nearest", en: "Nearest Neighbor (hard edges)", ru: "По соседним пикселям (чёткие края)" },
  { id: "bilinear", en: "Bilinear", ru: "Билинейная" },
];

/** Photoshop's Fit To list, the common screen and print sizes; a print size carries its
 * resolution with it. */
const FIT_TO: readonly { en: string; ru: string; width: number; height: number; unit: Unit; resolution?: number }[] = [
  { en: "640 × 480 px", ru: "640 × 480 пикс", width: 640, height: 480, unit: "px" },
  { en: "800 × 600 px", ru: "800 × 600 пикс", width: 800, height: 600, unit: "px" },
  { en: "1024 × 768 px", ru: "1024 × 768 пикс", width: 1024, height: 768, unit: "px" },
  { en: "1280 × 800 px", ru: "1280 × 800 пикс", width: 1280, height: 800, unit: "px" },
  { en: "1366 × 768 px", ru: "1366 × 768 пикс", width: 1366, height: 768, unit: "px" },
  { en: "1920 × 1080 px", ru: "1920 × 1080 пикс", width: 1920, height: 1080, unit: "px" },
  { en: "4 × 6 in, 300 ppi", ru: "4 × 6 дюймов, 300 пикс/дюйм", width: 6, height: 4, unit: "in", resolution: 300 },
  { en: "5 × 7 in, 300 ppi", ru: "5 × 7 дюймов, 300 пикс/дюйм", width: 7, height: 5, unit: "in", resolution: 300 },
  { en: "8 × 10 in, 300 ppi", ru: "8 × 10 дюймов, 300 пикс/дюйм", width: 10, height: 8, unit: "in", resolution: 300 },
  { en: "A4, 300 ppi", ru: "A4, 300 пикс/дюйм", width: 297, height: 210, unit: "mm", resolution: 300 },
  { en: "A3, 300 ppi", ru: "A3, 300 пикс/дюйм", width: 420, height: 297, unit: "mm", resolution: 300 },
];

const UNITS: readonly { id: Unit; en: string; ru: string }[] = [
  { id: "px", en: "Pixels", ru: "Пиксели" },
  { id: "percent", en: "Percent", ru: "Проценты" },
  { id: "in", en: "Inches", ru: "Дюймы" },
  { id: "cm", en: "Centimeters", ru: "Сантиметры" },
  { id: "mm", en: "Millimeters", ru: "Миллиметры" },
];

export const formatBytes = (bytes: number, language: "en" | "ru" | string) => {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(2)} ${text(language as never, "MB", "МБ")}` : `${Math.max(1, Math.round(bytes / 1024))} ${text(language as never, "KB", "КБ")}`;
};

/**
 * Image ▸ Image Size (Ctrl+Alt+I), laid out as Photoshop's dialog: the size readout with what it
 * was, Fit To, Width and Height with one unit and the proportions link, Resolution, and Resample
 * with its method. With Resample off the pixels stay as they are and only the print size and
 * resolution trade against each other, which is what Photoshop does too (§65.13).
 */
function ImageSize({ width, height, resolution, resolutionUnit, bytesPerPixel, onResolve, close }: ImageSizeProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const [pixels, setPixels] = useState({ width, height });
  const [ppi, setPpi] = useState(resolutionUnit === "ppcm" ? resolution * 2.54 : resolution);
  const [unit, setUnit] = useState<Unit>("px");
  const [linked, setLinked] = useState(true);
  const [resample, setResample] = useState(true);
  const [method, setMethod] = useState<ResampleMethod>("auto");
  const cancel = () => { onResolve(null); close(); };
  const accept = () => {
    const w = Math.max(1, Math.round(pixels.width)), h = Math.max(1, Math.round(pixels.height));
    onResolve({ width: resample ? w : width, height: resample ? h : height, resolution: resolutionUnit === "ppcm" ? ppi / 2.54 : ppi, resample: resample && (w !== width || h !== height) ? method : null });
    close();
  };

  const toUnit = (px: number, original: number) => unit === "px" ? px : unit === "percent" ? px / original * 100 : unit === "in" ? px / ppi : unit === "cm" ? px / ppi * 2.54 : px / ppi * 25.4;
  const fromUnit = (value: number, original: number) => unit === "px" ? value : unit === "percent" ? value / 100 * original : unit === "in" ? value * ppi : unit === "cm" ? value / 2.54 * ppi : value / 25.4 * ppi;
  const round = (value: number) => unit === "px" ? Math.round(value) : Math.round(value * 100) / 100;

  const setDimension = (axis: "width" | "height", value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    const original = axis === "width" ? width : height;
    const px = fromUnit(value, original);
    if (!resample) {
      // Pixels fixed: a new print size means a new resolution.
      if (unit === "px" || unit === "percent") return;
      setPpi(ppi * px / (axis === "width" ? pixels.width : pixels.height));
      return;
    }
    setPixels((current) => {
      if (!linked) return { ...current, [axis]: px };
      return axis === "width" ? { width: px, height: px * height / width } : { width: px * width / height, height: px };
    });
  };
  const setResolution = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    const next = resolutionUnit === "ppcm" ? value * 2.54 : value;
    // With Resample on and a physical unit, keeping the print size means changing the pixels.
    if (resample && unit !== "px" && unit !== "percent") setPixels((current) => ({ width: current.width * next / ppi, height: current.height * next / ppi }));
    setPpi(next);
  };
  const fit = (index: number) => {
    const preset = FIT_TO[index];
    if (!preset) { setPixels({ width, height }); return; }
    const presetPpi = preset.resolution ?? ppi;
    const toPx = (value: number) => preset.unit === "px" ? value : preset.unit === "in" ? value * presetPpi : value / 25.4 * presetPpi;
    let w = toPx(preset.width), h = toPx(preset.height);
    // A portrait image takes the preset turned to match, and the link keeps its own proportions
    // inside the preset's box.
    if (height > width) [w, h] = [h, w];
    if (linked) { const scale = Math.min(w / width, h / height); w = width * scale; h = height * scale; }
    if (preset.resolution) setPpi(preset.resolution);
    setResample(true);
    setPixels({ width: w, height: h });
  };

  const newBytes = Math.round(pixels.width) * Math.round(pixels.height) * bytesPerPixel, oldBytes = width * height * bytesPerPixel;
  const shownResolution = resolutionUnit === "ppcm" ? ppi / 2.54 : ppi;

  return <ModalBackdrop className="rasterize-confirm-backdrop" onMouseDown={cancel}>
    <section className="rasterize-confirm size-dialog" role="dialog" aria-modal="true" tabIndex={-1} ref={(node) => node?.focus()}
      onKeyDown={(event) => { if (event.key === "Escape") cancel(); if (event.key === "Enter") accept(); }}
      onMouseDown={(event) => event.stopPropagation()}>
      <strong>{text(language, "Image Size", "Размер изображения")}</strong>
      <p className="size-dialog-readout">
        {text(language, "Image size", "Размер")}: <b>{formatBytes(newBytes, language)}</b>
        {newBytes !== oldBytes && <> ({text(language, "was", "было")} {formatBytes(oldBytes, language)})</>}
        <br/>{text(language, "Dimensions", "Измерения")}: <b>{Math.round(pixels.width)} × {Math.round(pixels.height)} {text(language, "px", "пикс")}</b>
      </p>
      <label className="size-dialog-row">{text(language, "Fit To", "Подогнать под")}
        <select defaultValue="" onChange={(event) => fit(Number(event.target.value))}>
          <option value="" disabled hidden>{text(language, "Original Size", "Исходный размер")}</option>
          <option value={-1}>{text(language, "Original Size", "Исходный размер")}</option>
          {FIT_TO.map((preset, index) => <option key={preset.en} value={index}>{text(language, preset.en, preset.ru)}</option>)}
        </select>
      </label>
      <div className="size-dialog-dimensions">
        <label className="size-dialog-row">{text(language, "Width", "Ширина")}
          <input type="number" min={0} step="any" value={round(toUnit(pixels.width, width))} disabled={!resample && (unit === "px" || unit === "percent")} onChange={(event) => setDimension("width", event.target.valueAsNumber)}/>
        </label>
        <label className="size-dialog-row">{text(language, "Height", "Высота")}
          <input type="number" min={0} step="any" value={round(toUnit(pixels.height, height))} disabled={!resample && (unit === "px" || unit === "percent")} onChange={(event) => setDimension("height", event.target.valueAsNumber)}/>
        </label>
        <button className={linked ? "size-dialog-link active" : "size-dialog-link"} aria-pressed={linked} disabled={!resample}
          title={text(language, "Constrain aspect ratio", "Сохранять пропорции")} onClick={() => setLinked((value) => !value)}>🔗</button>
        <select className="size-dialog-unit" value={unit} onChange={(event) => setUnit(event.target.value as Unit)} aria-label={text(language, "Units", "Единицы")}>
          {UNITS.map((entry) => <option key={entry.id} value={entry.id}>{text(language, entry.en, entry.ru)}</option>)}
        </select>
      </div>
      <label className="size-dialog-row">{text(language, "Resolution", "Разрешение")}
        <input type="number" min={1} step="any" value={Math.round(shownResolution * 100) / 100} onChange={(event) => setResolution(event.target.valueAsNumber)}/>
        <span>{resolutionUnit === "ppcm" ? text(language, "px/cm", "пикс/см") : text(language, "px/in", "пикс/дюйм")}</span>
      </label>
      <label className="size-dialog-row size-dialog-resample">
        <input type="checkbox" checked={resample} onChange={(event) => { setResample(event.target.checked); if (!event.target.checked) setPixels({ width, height }); }}/>
        {text(language, "Resample", "Ресемплинг")}
        <select value={method} disabled={!resample} onChange={(event) => setMethod(event.target.value as ResampleMethod)}>
          {METHODS.map((entry) => <option key={entry.id} value={entry.id}>{text(language, entry.en, entry.ru)}</option>)}
        </select>
      </label>
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" onClick={accept}>OK</button>
      </footer>
    </section>
  </ModalBackdrop>;
}

export default { id: "image-size", component: ImageSize } satisfies ModalDefinition<ImageSizeProps> as ModalDefinition<never>;
