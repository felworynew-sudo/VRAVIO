import { useMemo, useRef, useState } from "react";
import { computeAutoLevels, defaultAutoLevelsOptions, type AutoLevelsOptions, type LevelsChannelPoints, type RasterAdjustment } from "@vravio/env-raster";
import { NumberBox } from "../ui/atoms/NumberBox";
import { text } from "../i18n";
import type { Language } from "../store";
import { levelsPresets, matchingLevelsPreset, applyLevelsPreset } from "./levels-presets";
import { LevelsAutoOptionsDialog } from "./LevelsAutoOptionsDialog";

type Channel = "rgb" | "red" | "green" | "blue";
const CHANNEL_LABELS: Record<Channel, { en: string; ru: string }> = { rgb: { en: "RGB", ru: "RGB" }, red: { en: "Red", ru: "Красный" }, green: { en: "Green", ru: "Зелёный" }, blue: { en: "Blue", ru: "Синий" } };
const AUTO_LEVELS_STORAGE_KEY = "vravio.raster.auto-levels-options";

function loadAutoLevelsOptions(): AutoLevelsOptions {
  try {
    const raw = localStorage.getItem(AUTO_LEVELS_STORAGE_KEY);
    if (!raw) return defaultAutoLevelsOptions;
    return { ...defaultAutoLevelsOptions, ...(JSON.parse(raw) as Partial<AutoLevelsOptions>) };
  } catch { return defaultAutoLevelsOptions; }
}

function channelHistogramBins(pixels: Uint8ClampedArray | undefined, channel: Channel): number[] {
  const bins = new Array<number>(256).fill(0);
  if (!pixels) return bins;
  const offset = channel === "red" ? 0 : channel === "green" ? 1 : channel === "blue" ? 2 : -1;
  for (let base = 0; base < pixels.length; base += 4) {
    if (pixels[base + 3] === 0) continue;
    const value = offset >= 0 ? pixels[base + offset]! : Math.round(pixels[base]! * .2126 + pixels[base + 1]! * .7152 + pixels[base + 2]! * .0722);
    bins[value]! += 1;
  }
  return bins;
}

/** A value from 0 to 1 along a horizontal track, dragged with the pointer — the shared gesture every handle below uses. */
function useTrackDrag(trackRef: React.RefObject<HTMLDivElement | null>, onChange: (fraction: number) => void) {
  return (event: React.PointerEvent) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      onChange(Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width)));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

function gammaHandleFraction(points: LevelsChannelPoints): number {
  return .5 ** Math.max(.1, Math.min(9.99, points.gamma));
}
function gammaFromFraction(fraction: number): number {
  return Math.max(.1, Math.min(9.99, -Math.log2(Math.max(1e-4, Math.min(1 - 1e-4, fraction)))));
}

function InputHistogram({ bins, points, language, onChange }: { bins: readonly number[]; points: LevelsChannelPoints; language: Language; onChange(patch: Partial<LevelsChannelPoints>): void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const max = Math.max(1, ...bins);
  const barPoints = bins.map((value, index) => `${index / 255 * 100},${100 - value / max * 98}`).join(" L");
  const blackPercent = points.blackInput / 255 * 100, whitePercent = points.whiteInput / 255 * 100, gammaPercent = (points.blackInput + (points.whiteInput - points.blackInput) * gammaHandleFraction(points)) / 255 * 100;
  const dragBlack = useTrackDrag(trackRef, (fraction) => onChange({ blackInput: Math.max(0, Math.min(points.whiteInput - 1, Math.round(fraction * 255))) }));
  const dragWhite = useTrackDrag(trackRef, (fraction) => onChange({ whiteInput: Math.max(points.blackInput + 1, Math.min(255, Math.round(fraction * 255))) }));
  const dragGamma = useTrackDrag(trackRef, (fraction) => {
    const value = fraction * 255;
    const span = points.whiteInput - points.blackInput;
    if (span <= 0) return;
    onChange({ gamma: gammaFromFraction(Math.max(1e-4, Math.min(1 - 1e-4, (value - points.blackInput) / span))) });
  });
  return <div className="levels-histogram-block">
    <svg className="adjustment-histogram levels-histogram" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Histogram (Гистограмма)"><path d={`M0,100 L${barPoints} L100,100 Z`} /></svg>
    <div ref={trackRef} className="levels-handles-track">
      <div className="levels-handle levels-handle-black" style={{ left: `${blackPercent}%` }} onPointerDown={dragBlack} title={text(language, "Input black point", "Вход: чёрная точка")} />
      <div className="levels-handle levels-handle-gamma" style={{ left: `${gammaPercent}%` }} onPointerDown={dragGamma} title={text(language, "Gamma", "Гамма")} />
      <div className="levels-handle levels-handle-white" style={{ left: `${whitePercent}%` }} onPointerDown={dragWhite} title={text(language, "Input white point", "Вход: белая точка")} />
    </div>
  </div>;
}

function OutputBar({ points, onChange }: { points: LevelsChannelPoints; onChange(patch: Partial<LevelsChannelPoints>): void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const blackPercent = points.blackOutput / 255 * 100, whitePercent = points.whiteOutput / 255 * 100;
  const dragBlack = useTrackDrag(trackRef, (fraction) => onChange({ blackOutput: Math.max(0, Math.min(points.whiteOutput, Math.round(fraction * 255))) }));
  const dragWhite = useTrackDrag(trackRef, (fraction) => onChange({ whiteOutput: Math.max(points.blackOutput, Math.min(255, Math.round(fraction * 255))) }));
  return <div className="levels-output-block">
    <div className="levels-output-gradient" />
    <div ref={trackRef} className="levels-handles-track">
      <div className="levels-handle levels-handle-black" style={{ left: `${blackPercent}%` }} onPointerDown={dragBlack} />
      <div className="levels-handle levels-handle-white" style={{ left: `${whitePercent}%` }} onPointerDown={dragWhite} />
    </div>
  </div>;
}

/**
 * Photoshop's Levels dialog: a Channel/Набор pair of dropdowns, the input
 * histogram with its three draggable points, the output gradient with its
 * two, and Auto/Параметры… wired to auto-levels.ts's own four models —
 * laid out to match the owner's own screenshot rather than the generic
 * slider stack every other adjustment in AdjustmentEditor.tsx still uses.
 * Levels is the one adjustment whose real interface is a histogram, not a
 * row of numbers, which is the whole reason this got its own file instead
 * of a sixth branch added to that switch (CLAUDE.md §6).
 */
export function LevelsEditor({ value, language, pixels, onChange }: { value: Extract<RasterAdjustment, { kind: "levels" }>; language: Language; pixels?: Uint8ClampedArray | undefined; onChange(value: RasterAdjustment): void }) {
  const [channel, setChannel] = useState<Channel>("rgb");
  const [autoOptions, setAutoOptions] = useState<AutoLevelsOptions>(loadAutoLevelsOptions);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const bins = useMemo(() => channelHistogramBins(pixels, channel), [pixels, channel]);

  const points: LevelsChannelPoints = channel === "rgb" ? value : value.channels?.[channel] ?? value;
  const updatePoints = (patch: Partial<LevelsChannelPoints>) => {
    if (channel === "rgb") { onChange({ ...value, ...patch }); return; }
    const existing: LevelsChannelPoints = value.channels?.[channel] ?? { blackInput: value.blackInput, gamma: value.gamma, whiteInput: value.whiteInput, blackOutput: value.blackOutput, whiteOutput: value.whiteOutput };
    onChange({ ...value, channels: { ...value.channels, [channel]: { ...existing, ...patch } } });
  };

  const presetId = matchingLevelsPreset(value);
  const applyPreset = (id: string) => { const next = applyLevelsPreset(id); if (next) onChange(next); };

  const runAuto = () => { if (pixels) onChange(computeAutoLevels(pixels, autoOptions)); };

  return <div className="levels-editor">
    <div className="levels-editor-selectors">
      <label className="adjustment-channel">{text(language, "Preset", "Набор")}<select value={presetId} onChange={(event) => applyPreset(event.target.value)}>
        {presetId === "custom" && <option value="custom">{text(language, "Custom", "Заказная")}</option>}
        {levelsPresets.map((preset) => <option key={preset.id} value={preset.id}>{text(language, preset.name.en, preset.name.ru)}</option>)}
      </select></label>
      <label className="adjustment-channel">{text(language, "Channel", "Канал")}<select value={channel} onChange={(event) => setChannel(event.target.value as Channel)}>
        {(["rgb", "red", "green", "blue"] as const).map((id) => <option key={id} value={id}>{text(language, CHANNEL_LABELS[id].en, CHANNEL_LABELS[id].ru)}</option>)}
      </select></label>
    </div>
    <InputHistogram bins={bins} points={points} language={language} onChange={updatePoints} />
    <div className="levels-input-fields">
      <NumberBox value={points.blackInput} spec={{ min: 0, max: points.whiteInput - 1 }} onChange={(blackInput) => updatePoints({ blackInput })} />
      <NumberBox value={Math.round(points.gamma * 100) / 100} spec={{ min: .1, max: 9.99, step: .01 }} onChange={(gamma) => updatePoints({ gamma })} />
      <NumberBox value={points.whiteInput} spec={{ min: points.blackInput + 1, max: 255 }} onChange={(whiteInput) => updatePoints({ whiteInput })} />
    </div>
    <OutputBar points={points} onChange={updatePoints} />
    <div className="levels-output-fields">
      <NumberBox value={points.blackOutput} spec={{ min: 0, max: points.whiteOutput }} onChange={(blackOutput) => updatePoints({ blackOutput })} />
      <NumberBox value={points.whiteOutput} spec={{ min: points.blackOutput, max: 255 }} onChange={(whiteOutput) => updatePoints({ whiteOutput })} />
    </div>
    <div className="levels-auto-buttons">
      <button onClick={runAuto} disabled={!pixels}>{text(language, "Auto", "Авто")}</button>
      <button onClick={() => setOptionsOpen(true)}>{text(language, "Options…", "Параметры…")}</button>
    </div>
    {optionsOpen && <LevelsAutoOptionsDialog options={autoOptions} language={language} onCancel={() => setOptionsOpen(false)} onApply={(next, saveAsDefault) => {
      setAutoOptions(next);
      if (saveAsDefault) try { localStorage.setItem(AUTO_LEVELS_STORAGE_KEY, JSON.stringify(next)); } catch { /* no storage available — the session's own choice still applies */ }
      setOptionsOpen(false);
    }} />}
  </div>;
}
