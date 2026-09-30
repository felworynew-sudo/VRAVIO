import { useState } from "react";
import { useShellStore } from "../../store";
import { text } from "../../i18n";
import type { ModalDefinition } from "../types";
import { ModalBackdrop } from "../ModalBackdrop";

type Unit = "px" | "percent" | "in" | "cm" | "mm";
export type CanvasExtension = "transparent" | "foreground" | "background" | "white" | "black" | "gray" | "other";

export interface CanvasSizeAnswer {
  readonly width: number;
  readonly height: number;
  readonly anchor: readonly [-1 | 0 | 1, -1 | 0 | 1];
  /** A colour for the new area of the bottom layer, or null for transparent. */
  readonly fill: string | null;
}

interface CanvasSizeProps {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly resolutionUnit: "ppi" | "ppcm";
  readonly onResolve: (answer: CanvasSizeAnswer | null) => void;
}

const UNITS: readonly { id: Unit; en: string; ru: string }[] = [
  { id: "px", en: "Pixels", ru: "Пиксели" },
  { id: "percent", en: "Percent", ru: "Проценты" },
  { id: "in", en: "Inches", ru: "Дюймы" },
  { id: "cm", en: "Centimeters", ru: "Сантиметры" },
  { id: "mm", en: "Millimeters", ru: "Миллиметры" },
];

const EXTENSIONS: readonly { id: CanvasExtension; en: string; ru: string }[] = [
  { id: "transparent", en: "Transparent", ru: "Прозрачный" },
  { id: "foreground", en: "Foreground", ru: "Основной цвет" },
  { id: "background", en: "Background", ru: "Фоновый цвет" },
  { id: "white", en: "White", ru: "Белый" },
  { id: "black", en: "Black", ru: "Чёрный" },
  { id: "gray", en: "Gray", ru: "Серый" },
  { id: "other", en: "Other…", ru: "Другой…" },
];

const ARROWS: Record<string, string> = { "-1,-1": "↖", "0,-1": "↑", "1,-1": "↗", "-1,0": "←", "0,0": "•", "1,0": "→", "-1,1": "↙", "0,1": "↓", "1,1": "↘" };

/**
 * Image ▸ Canvas Size (Ctrl+Alt+C), as Photoshop's dialog: Current Size, New Size with units and
 * Relative, the 3×3 Anchor, and Canvas extension color. No layer is resampled — the canvas grows or
 * shrinks around the anchor. Photoshop applies the extension colour to the Background layer; this
 * document model has no Background layer, so it is applied to the bottom layer, and "Transparent"
 * leaves new canvas empty (§65.13).
 */
function CanvasSize({ width, height, resolution, resolutionUnit, onResolve, close }: CanvasSizeProps & { close: () => void }) {
  const language = useShellStore((state) => state.language);
  const foreground = useShellStore((state) => state.foregroundColor);
  const background = useShellStore((state) => state.backgroundColor);
  const ppi = resolutionUnit === "ppcm" ? resolution * 2.54 : resolution;
  const [unit, setUnit] = useState<Unit>("px");
  const [relative, setRelative] = useState(false);
  const [size, setSize] = useState({ width, height });
  const [anchor, setAnchor] = useState<readonly [-1 | 0 | 1, -1 | 0 | 1]>([0, 0]);
  const [extension, setExtension] = useState<CanvasExtension>("transparent");
  const [other, setOther] = useState("#808080");
  const cancel = () => { onResolve(null); close(); };
  const accept = () => {
    const fill = extension === "transparent" ? null : extension === "foreground" ? foreground : extension === "background" ? background
      : extension === "white" ? "#ffffff" : extension === "black" ? "#000000" : extension === "gray" ? "#808080" : other;
    onResolve({ width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)), anchor, fill });
    close();
  };

  const toUnit = (px: number, original: number) => unit === "px" ? px : unit === "percent" ? px / original * 100 : unit === "in" ? px / ppi : unit === "cm" ? px / ppi * 2.54 : px / ppi * 25.4;
  const fromUnit = (value: number, original: number) => unit === "px" ? value : unit === "percent" ? value / 100 * original : unit === "in" ? value * ppi : unit === "cm" ? value / 2.54 * ppi : value / 25.4 * ppi;
  const round = (value: number) => unit === "px" ? Math.round(value) : Math.round(value * 100) / 100;
  // Relative shows the change, not the result — and a percentage of change, for percent.
  const shown = (px: number, original: number) => relative ? (unit === "percent" ? (px - original) / original * 100 : toUnit(px - original, original)) : toUnit(px, original);
  const setAxis = (axis: "width" | "height", value: number) => {
    if (!Number.isFinite(value)) return;
    const original = axis === "width" ? width : height;
    const px = relative ? original + (unit === "percent" ? value / 100 * original : fromUnit(value, original)) : fromUnit(value, original);
    if (px < 1) return;
    setSize((current) => ({ ...current, [axis]: px }));
  };

  return <ModalBackdrop className="rasterize-confirm-backdrop" onMouseDown={cancel}>
    <section className="rasterize-confirm size-dialog" role="dialog" aria-modal="true" tabIndex={-1} ref={(node) => node?.focus()}
      onKeyDown={(event) => { if (event.key === "Escape") cancel(); if (event.key === "Enter") accept(); }}
      onMouseDown={(event) => event.stopPropagation()}>
      <strong>{text(language, "Canvas Size", "Размер холста")}</strong>
      <p className="size-dialog-readout">{text(language, "Current size", "Текущий размер")}: <b>{width} × {height} {text(language, "px", "пикс")}</b></p>
      <div className="size-dialog-dimensions">
        <label className="size-dialog-row">{text(language, "Width", "Ширина")}
          <input type="number" step="any" value={round(shown(size.width, width))} onChange={(event) => setAxis("width", event.target.valueAsNumber)}/>
        </label>
        <label className="size-dialog-row">{text(language, "Height", "Высота")}
          <input type="number" step="any" value={round(shown(size.height, height))} onChange={(event) => setAxis("height", event.target.valueAsNumber)}/>
        </label>
        <select className="size-dialog-unit" value={unit} onChange={(event) => setUnit(event.target.value as Unit)} aria-label={text(language, "Units", "Единицы")}>
          {UNITS.map((entry) => <option key={entry.id} value={entry.id}>{text(language, entry.en, entry.ru)}</option>)}
        </select>
      </div>
      <label className="size-dialog-row size-dialog-check"><input type="checkbox" checked={relative} onChange={(event) => setRelative(event.target.checked)}/>{text(language, "Relative", "Относительно")}</label>
      <div className="size-dialog-row">{text(language, "Anchor", "Расположение")}
        <div className="size-dialog-anchor" role="radiogroup" aria-label={text(language, "Anchor", "Расположение")}>
          {([-1, 0, 1] as const).flatMap((y) => ([-1, 0, 1] as const).map((x) => {
            const selected = anchor[0] === x && anchor[1] === y;
            return <button key={`${x},${y}`} role="radio" aria-checked={selected} className={selected ? "active" : ""} onClick={() => setAnchor([x, y])}>{selected ? "•" : ARROWS[`${x - anchor[0]},${y - anchor[1]}`] ?? ""}</button>;
          }))}
        </div>
      </div>
      <label className="size-dialog-row">{text(language, "Canvas extension color", "Цвет расширения холста")}
        <select value={extension} onChange={(event) => setExtension(event.target.value as CanvasExtension)}>
          {EXTENSIONS.map((entry) => <option key={entry.id} value={entry.id}>{text(language, entry.en, entry.ru)}</option>)}
        </select>
        {extension === "other" && <input type="color" value={other} onChange={(event) => setOther(event.target.value)} aria-label={text(language, "Color", "Цвет")}/>}
      </label>
      {extension !== "transparent" && <p className="size-dialog-note">{text(language, "Fills the added area of the bottom layer.", "Заполняет добавленную область нижнего слоя.")}</p>}
      <footer>
        <button onClick={cancel}>{text(language, "Cancel", "Отмена")}</button>
        <button className="primary" onClick={accept}>OK</button>
      </footer>
    </section>
  </ModalBackdrop>;
}

export default { id: "canvas-size", component: CanvasSize } satisfies ModalDefinition<CanvasSizeProps> as ModalDefinition<never>;
