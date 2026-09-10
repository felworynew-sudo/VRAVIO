import { useState } from "react";
import { toHexColor, parseHexColor, type AutoLevelsModel, type AutoLevelsOptions } from "@vravio/env-raster";
import { NumberBox } from "../ui/atoms/NumberBox";
import { Checkbox } from "../ui/atoms/Checkbox";
import { text } from "../i18n";
import type { Language } from "../store";

const MODELS: readonly { id: AutoLevelsModel; en: string; ru: string }[] = [
  { id: "monochromaticContrast", en: "Enhance Monochromatic Contrast", ru: "Улучшить монохроматический контраст" },
  { id: "perChannelContrast", en: "Enhance Per Channel Contrast", ru: "Улучшить контраст по каналам" },
  { id: "findDarkLightColors", en: "Find Dark and Light Colors", ru: "Найти темные и светлые цвета" },
  { id: "brightnessContrast", en: "Enhance Brightness and Contrast", ru: "Улучшить яркость и контраст" },
];

const CLIP_SPEC = { min: 0, max: 9.99, step: 0.01, unit: "%" };

/**
 * Photoshop's own Auto Color Correction Options dialog — the "Параметры…"
 * button next to Levels' "Авто" (LevelsEditor.tsx), laid out to match the
 * owner's own screenshot: a Models radio group, the neutral-midtones
 * checkbox, three target-colour swatches with their own clip percentages,
 * and "save as defaults". The four models and what each number here feeds
 * into are auto-levels.ts's own business, not this file's — this is purely
 * the form around it.
 */
export function LevelsAutoOptionsDialog({ options, language, onApply, onCancel }: { options: AutoLevelsOptions; language: Language; onApply(options: AutoLevelsOptions, saveAsDefault: boolean): void; onCancel(): void }) {
  const [draft, setDraft] = useState(options);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const patch = (next: Partial<AutoLevelsOptions>) => setDraft({ ...draft, ...next });
  const swatch = (key: "targetShadow" | "targetMidtone" | "targetHighlight", labelEn: string, labelRu: string) => <label className="auto-levels-target">
    <span>{text(language, labelEn, labelRu)}</span>
    <input type="color" value={toHexColor(draft[key])} onChange={(event) => patch({ [key]: { ...parseHexColor(event.target.value), a: 255 } })} />
  </label>;
  return <div className="modeless-layer"><section className="adjustment-dialog auto-levels-options" role="dialog" aria-modal="true">
    <header><strong>{text(language, "Auto Color Correction Options", "Параметры автоматической цветокоррекции")}</strong><button onClick={onCancel}>×</button></header>
    <div className="auto-levels-options-body">
      <fieldset className="auto-levels-models">
        <legend>{text(language, "Models", "Модели")}</legend>
        {MODELS.map((model) => <label key={model.id}><input type="radio" name="auto-levels-model" checked={draft.model === model.id} onChange={() => patch({ model: model.id })} />{text(language, model.en, model.ru)}</label>)}
        <label className="auto-levels-snap"><input type="checkbox" checked={draft.snapNeutralMidtones} onChange={(event) => patch({ snapNeutralMidtones: event.target.checked })} disabled={draft.model !== "findDarkLightColors"} />{text(language, "Snap Neutral Midtones", "Привязать к нейтральным средним тонам")}</label>
      </fieldset>
      <fieldset className="auto-levels-targets">
        <legend>{text(language, "Target Colors & Clipping", "Целевые цвета и потеря цветов")}</legend>
        <div className="auto-levels-target-row">{swatch("targetShadow", "Shadows", "Тени")}<NumberBox label={text(language, "Clip", "Усечение")} value={draft.shadowClip} spec={CLIP_SPEC} onChange={(shadowClip) => patch({ shadowClip })} /></div>
        <div className="auto-levels-target-row">{swatch("targetMidtone", "Midtones", "Средние тона")}</div>
        <div className="auto-levels-target-row">{swatch("targetHighlight", "Highlights", "Света")}<NumberBox label={text(language, "Clip", "Усечение")} value={draft.highlightClip} spec={CLIP_SPEC} onChange={(highlightClip) => patch({ highlightClip })} /></div>
      </fieldset>
      <Checkbox label={text(language, "Save as defaults", "Сохранить в качестве значений по умолчанию")} checked={saveAsDefault} onChange={setSaveAsDefault} />
    </div>
    <div className="auto-levels-options-actions">
      <button className="primary" onClick={() => onApply(draft, saveAsDefault)}>{text(language, "OK", "OK")}</button>
      <button onClick={onCancel}>{text(language, "Cancel", "Отмена")}</button>
    </div>
  </section></div>;
}
