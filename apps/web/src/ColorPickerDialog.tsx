import { useEffect, useRef, useState } from "react";
import { parseHexColor, toHexColor } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";

type Rgb = { r: number; g: number; b: number };

function rgbToHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min;
  const hue = delta === 0 ? 0 : max === red ? 60 * (((green - blue) / delta) % 6) : max === green ? 60 * ((blue - red) / delta + 2) : 60 * ((red - green) / delta + 4);
  return { h: (hue + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

function hsvToRgb(h: number, s: number, v: number): Rgb {
  const chroma = v * s, secondary = chroma * (1 - Math.abs(((h / 60) % 2) - 1)), match = v - chroma;
  const [red, green, blue] = h < 60 ? [chroma, secondary, 0] : h < 120 ? [secondary, chroma, 0] : h < 180 ? [0, chroma, secondary]
    : h < 240 ? [0, secondary, chroma] : h < 300 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  return { r: Math.round((red + match) * 255), g: Math.round((green + match) * 255), b: Math.round((blue + match) * 255) };
}

/** The web-safe palette is every channel rounded to a multiple of 51 (0,51,102,153,204,255) — the classic 216-color "web safe" set. */
const toWebSafe = ({ r, g, b }: Rgb): Rgb => { const snap = (value: number) => Math.round(value / 51) * 51; return { r: snap(r), g: snap(g), b: snap(b) }; };
const isWebSafe = (rgb: Rgb): boolean => { const safe = toWebSafe(rgb); return safe.r === rgb.r && safe.g === rgb.g && safe.b === rgb.b; };
const toHex = ({ r, g, b }: Rgb) => toHexColor({ r, g, b, a: 255 });

const SWATCH_STORAGE_KEY = "vravio.color.customSwatches";
function readCustomSwatches(): string[] {
  try { const raw = localStorage.getItem(SWATCH_STORAGE_KEY); return raw ? (JSON.parse(raw) as string[]) : []; } catch { return []; }
}
function writeCustomSwatches(swatches: readonly string[]): void {
  try { localStorage.setItem(SWATCH_STORAGE_KEY, JSON.stringify(swatches)); } catch { /* swatches are a convenience, not data worth failing over */ }
}

/**
 * Adobe's Color Picker, adapted: a 2D saturation/value field with a hue strip, numeric
 * RGB/HSB and hex entry, an old/new comparison swatch (the thing a docked color panel has no
 * room for), and the "only web colors" constraint with its own warning when the live pick
 * falls outside it. Nothing here commits until Apply — Cancel restores exactly what was active
 * when the dialog opened, matching the modal original.
 */
export function ColorPickerDialog({ language, initial, onApply, onClose }: { language: Language; initial: string; onApply(hex: string): void; onClose(): void }) {
  const [value, setValue] = useState(initial);
  const [webSafeOnly, setWebSafeOnly] = useState(false);
  const [swatches, setSwatches] = useState<string[]>(() => readCustomSwatches());
  const fieldRef = useRef<HTMLCanvasElement>(null);
  const rgb = parseHexColor(value);
  const hsv = rgbToHsv(rgb);
  const outOfWebGamut = !isWebSafe(rgb);

  useEffect(() => {
    const canvas = fieldRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const { r, g, b } = hsvToRgb(hsv.h, x / (canvas.width - 1), 1 - y / (canvas.height - 1));
      const index = (y * canvas.width + x) * 4;
      image.data[index] = r; image.data[index + 1] = g; image.data[index + 2] = b; image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [hsv.h]);

  const apply = (next: Rgb) => setValue(toHex(webSafeOnly ? toWebSafe(next) : next));

  const pickFromField = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.buttons !== 1 && event.type === "pointermove") return;
    const canvas = event.currentTarget, rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    apply(hsvToRgb(hsv.h, x, 1 - y));
  };

  const channel = (label: string, current: number, max: number, onChange: (next: number) => void) => <label className="picker-channel" key={label}>
    <span>{label}</span>
    <input type="number" min={0} max={max} value={Math.round(current)} onChange={(event) => onChange(Math.max(0, Math.min(max, event.target.valueAsNumber || 0)))} />
  </label>;

  const addSwatch = () => { const next = [value, ...swatches.filter((swatch) => swatch !== value)].slice(0, 40); setSwatches(next); writeCustomSwatches(next); };
  const removeSwatch = (swatch: string) => { const next = swatches.filter((item) => item !== swatch); setSwatches(next); writeCustomSwatches(next); };

  return <div className="dialog-backdrop" onMouseDown={onClose}>
    <section className="color-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="color-picker-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="color-picker-title">{text(language, "Color Picker", "Выбор цвета")}</h2><button onClick={onClose} aria-label={text(language, "Close", "Закрыть")}>×</button></header>
      <div className="color-picker-body">
        <div className="color-picker-field">
          <canvas ref={fieldRef} width={240} height={200} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pickFromField(event); }} onPointerMove={pickFromField} style={{ "--hue": hsv.h } as React.CSSProperties} />
          <div className="color-picker-marker" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
        </div>
        <input className="color-picker-hue" type="range" min={0} max={359} value={Math.round(hsv.h)} onChange={(event) => apply(hsvToRgb(event.target.valueAsNumber, hsv.s, hsv.v))} />
        <div className="color-picker-compare">
          <div className="color-picker-swatch-pair">
            <span className="picker-swatch" style={{ background: initial }} title={text(language, "Original", "Исходный")} />
            <span className="picker-swatch" style={{ background: value }} title={text(language, "New", "Новый")} />
          </div>
          <span className="picker-compare-label">{text(language, "New / Original", "Новый / Исходный")}</span>
        </div>
        <div className="color-picker-fields">
          <div className="color-picker-channels">
            {channel("H", hsv.h, 359, (next) => apply(hsvToRgb(next, hsv.s, hsv.v)))}
            {channel("S", hsv.s * 100, 100, (next) => apply(hsvToRgb(hsv.h, next / 100, hsv.v)))}
            {channel("B", hsv.v * 100, 100, (next) => apply(hsvToRgb(hsv.h, hsv.s, next / 100)))}
          </div>
          <div className="color-picker-channels">
            {channel("R", rgb.r, 255, (next) => apply({ ...rgb, r: next }))}
            {channel("G", rgb.g, 255, (next) => apply({ ...rgb, g: next }))}
            {channel("B", rgb.b, 255, (next) => apply({ ...rgb, b: next }))}
          </div>
          <label className="picker-hex"><span>#</span><input value={value.replace("#", "")} spellCheck={false} onChange={(event) => { const next = event.target.value.trim(); if (/^[0-9a-f]{6}$/i.test(next)) apply(parseHexColor(`#${next}`)); }} /></label>
          <label className="picker-websafe"><input type="checkbox" checked={webSafeOnly} onChange={(event) => { setWebSafeOnly(event.target.checked); if (event.target.checked) apply(rgb); }} />{text(language, "Only web colors", "Только веб-цвета")}</label>
          {outOfWebGamut && !webSafeOnly && <div className="picker-gamut-warning" title={text(language, "Not a web-safe color", "Не веб-безопасный цвет")}>
            <span className="picker-gamut-chip" style={{ background: toHex(toWebSafe(rgb)) }} onClick={() => apply(toWebSafe(rgb))} />
            {text(language, "⚠ Outside web-safe colors — click the swatch for the nearest one", "⚠ Вне веб-безопасных цветов — нажмите на образец, чтобы выбрать ближайший")}
          </div>}
        </div>
      </div>
      <div className="color-picker-swatches">
        <button className="picker-swatch-add" onClick={addSwatch} title={text(language, "Add to swatches", "Добавить в образцы")}>＋</button>
        {swatches.map((swatch) => <button key={swatch} className="picker-swatch-item" style={{ background: swatch }} title={swatch} onClick={() => setValue(swatch)} onContextMenu={(event) => { event.preventDefault(); removeSwatch(swatch); }} />)}
      </div>
      <footer>
        <button className="picker-cancel" onClick={onClose}>{text(language, "Cancel", "Отмена")}</button>
        <button className="picker-apply" onClick={() => { onApply(value); onClose(); }}>{text(language, "OK", "ОК")}</button>
      </footer>
    </section>
  </div>;
}
