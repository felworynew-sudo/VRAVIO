import { useEffect, useRef, useState } from "react";
import { parseHexColor, toHexColor } from "@vravio/env-raster";
import { useShellStore } from "./store";
import { text } from "./i18n";

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

const toHex = ({ r, g, b }: Rgb) => toHexColor({ r, g, b, a: 255 });

/** Photoshop's default swatch row, kept short so the panel stays usable when docked narrow. */
const swatches = ["#000000", "#404040", "#808080", "#c0c0c0", "#ffffff", "#ff0000", "#ff8000", "#ffff00", "#00ff00", "#00ffff", "#0080ff", "#0000ff", "#8000ff", "#ff00ff", "#803000", "#f0c8a0"];

export function ColorPanel() {
  const language = useShellStore((state) => state.language);
  const foreground = useShellStore((state) => state.foregroundColor);
  const background = useShellStore((state) => state.backgroundColor);
  const setForeground = useShellStore((state) => state.setForegroundColor);
  const setBackground = useShellStore((state) => state.setBackgroundColor);
  const swap = useShellStore((state) => state.swapColors);
  const reset = useShellStore((state) => state.resetColors);
  const [target, setTarget] = useState<"foreground" | "background">("foreground");
  const [model, setModel] = useState<"rgb" | "hsb">("rgb");
  const spectrumRef = useRef<HTMLCanvasElement>(null);

  const active = target === "foreground" ? foreground : background;
  const apply = (hex: string) => (target === "foreground" ? setForeground : setBackground)(hex);
  const rgb = parseHexColor(active);
  const hsv = rgbToHsv(rgb);

  // The spectrum is a static saturation/value field for the current hue; it only needs
  // repainting when the hue moves.
  useEffect(() => {
    const canvas = spectrumRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const { r, g, b } = hsvToRgb(hsv.h, x / (canvas.width - 1), 1 - y / (canvas.height - 1));
      const index = (y * canvas.width + x) * 4;
      image.data[index] = r; image.data[index + 1] = g; image.data[index + 2] = b; image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [hsv.h]);

  const pickFromSpectrum = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.buttons !== 1 && event.type === "pointermove") return;
    const canvas = event.currentTarget, rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    apply(toHex(hsvToRgb(hsv.h, x, 1 - y)));
  };

  const channel = (label: string, value: number, max: number, onChange: (next: number) => void) => <label className="color-slider" key={label}>
    <span>{label}</span>
    <input type="range" min={0} max={max} value={Math.round(value)} onChange={(event) => onChange(event.target.valueAsNumber)} />
    <input type="number" min={0} max={max} value={Math.round(value)} onChange={(event) => onChange(event.target.valueAsNumber)} />
  </label>;

  return <div className="dock-panel-body color-panel">
    <div className="color-chips">
      <button className={`color-chip${target === "foreground" ? " active" : ""}`} style={{ background: foreground }} onClick={() => setTarget("foreground")} title={text(language, "Foreground", "Основной")} aria-label={text(language, "Foreground", "Основной")} />
      <button className={`color-chip${target === "background" ? " active" : ""}`} style={{ background }} onClick={() => setTarget("background")} title={text(language, "Background", "Фоновый")} aria-label={text(language, "Background", "Фоновый")} />
      <div className="color-chip-actions">
        <button onClick={swap} title={`${text(language, "Swap", "Поменять")} (X)`}>⇄</button>
        <button onClick={reset} title={`${text(language, "Default", "По умолчанию")} (D)`}>◧</button>
      </div>
    </div>

    <canvas ref={spectrumRef} className="color-spectrum" width={220} height={110} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pickFromSpectrum(event); }} onPointerMove={pickFromSpectrum} />
    <label className="color-slider color-hue">
      <span>H</span>
      <input type="range" min={0} max={359} value={Math.round(hsv.h)} onChange={(event) => apply(toHex(hsvToRgb(event.target.valueAsNumber, hsv.s, hsv.v)))} />
      <input type="number" min={0} max={359} value={Math.round(hsv.h)} onChange={(event) => apply(toHex(hsvToRgb(event.target.valueAsNumber, hsv.s, hsv.v)))} />
    </label>

    <div className="color-model">
      {(["rgb", "hsb"] as const).map((option) => <button key={option} className={model === option ? "active" : ""} onClick={() => setModel(option)}>{option.toUpperCase()}</button>)}
    </div>

    {model === "rgb"
      ? [
          channel("R", rgb.r, 255, (value) => apply(toHex({ ...rgb, r: value }))),
          channel("G", rgb.g, 255, (value) => apply(toHex({ ...rgb, g: value }))),
          channel("B", rgb.b, 255, (value) => apply(toHex({ ...rgb, b: value }))),
        ]
      : [
          channel("S", hsv.s * 100, 100, (value) => apply(toHex(hsvToRgb(hsv.h, value / 100, hsv.v)))),
          channel("B", hsv.v * 100, 100, (value) => apply(toHex(hsvToRgb(hsv.h, hsv.s, value / 100)))),
        ]}

    <label className="color-hex">
      <span>#</span>
      <input value={active.replace("#", "")} spellCheck={false} onChange={(event) => { const next = event.target.value.trim(); if (/^[0-9a-f]{6}$/i.test(next)) apply(`#${next.toLowerCase()}`); }} />
    </label>

    <div className="color-swatches">
      {swatches.map((swatch) => <button key={swatch} style={{ background: swatch }} onClick={() => apply(swatch)} title={swatch} aria-label={swatch} />)}
    </div>
  </div>;
}
