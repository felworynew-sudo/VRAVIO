import type { RasterFilterParameter } from "@vravio/env-raster";
import { localized, text } from "../i18n";
import { AngleDial } from "../ui/atoms/AngleDial";
import { ButtonGroup } from "../ui/atoms/ButtonGroup";
import { Checkbox } from "../ui/atoms/Checkbox";
import { ColorSwatch } from "../ui/atoms/ColorSwatch";
import { SliderWithNumber } from "../ui/molecules/SliderWithNumber";
import type { FilterPanelEditorProps } from "./types";

// A packed 0xRRGGBB integer (the settings object stays `Record<string, number>`, see
// `RasterFilterParameter`'s own `kind: "color"` doc comment) round-tripped through the hex string
// `<input type="color">`/`ColorSwatch` actually wants.
const packedToHex = (packed: number) => `#${Math.max(0, Math.min(0xffffff, Math.round(packed))).toString(16).padStart(6, "0")}`;
const hexToPacked = (hex: string) => Number.parseInt(hex.slice(1), 16);

// Angle parameters get the same draggable dial `AdjustmentEditor.tsx`'s siblings never needed but
// this catalog's own Emboss/Wind/Kaleidoscope/Color Halftone panels do — a slider cannot represent
// "drag around a circle", and every reference screenshot with an angle control shows a dial for it.
const ANGLE_IDS = new Set(["angle", "angle1", "angle2", "angle3", "rotation"]);

function isOffOnChoices(choices: readonly string[]): boolean {
  return choices.length === 2 && /^off\b/i.test(choices[0]!) && /^on\b/i.test(choices[1]!);
}

/**
 * One generic editor driven entirely by `rasterFilterCatalog`'s own parameter metadata, instead of
 * a per-filter hand-written body — CLAUDE.md §6's "extend by file/data, not by a sixteenth branch"
 * applies just as much to a React component's own if-chain as to `filters.ts`'s dispatch: the
 * catalog already declares each parameter's id/range/choices precisely (Patchy/screenshot-verified
 * per filter, docs/master-plan.md §51), so the widget for it can be picked from that declaration
 * rather than re-declared by hand ~45 times. The mapping mirrors the reference screenshots' own
 * vocabulary: a 2-way "Off/On" choice is a checkbox, up to 4 named choices are the same segmented
 * button row the screenshots show for Technique/Direction/Shape, more than 4 falls back to a plain
 * dropdown (Mezzotint's 10 grain types), an angle-named parameter is the circular dial every
 * angle control in this project already uses, and everything else is the slider+number row every
 * adjustment dialog already shares.
 */
export function GenericFilterEditor({ parameters, settings, language, onChange }: FilterPanelEditorProps & { parameters: readonly RasterFilterParameter[] }) {
  if (parameters.length === 0) return <p className="panel-hint">{text(language, "No parameters", "Нет параметров")}</p>;
  return <>{parameters.map((parameter) => {
    const label = localized(parameter.name, language);
    const currentValue = Number.isFinite(settings[parameter.id]) ? settings[parameter.id]! : parameter.value;
    const setValue = (value: number) => onChange({ ...settings, [parameter.id]: value });
    if (parameter.kind === "color") {
      return <ColorSwatch key={parameter.id} className="adjustment-color" label={label} value={packedToHex(currentValue)} onChange={(hex) => setValue(hexToPacked(hex))}/>;
    }
    if (parameter.choices) {
      if (isOffOnChoices(parameter.choices)) {
        return <Checkbox key={parameter.id} className="adjustment-check" label={label} checked={currentValue >= parameter.max} onChange={(checked) => setValue(checked ? parameter.max : parameter.min)}/>;
      }
      if (parameter.choices.length <= 4) {
        const options = parameter.choices.map((choice, index) => ({ value: String(parameter.min + index), label: localized(choice, language) }));
        return <ButtonGroup key={parameter.id} className="adjustment-field" label={label} value={String(currentValue)} options={options} onChange={(value) => setValue(Number(value))}/>;
      }
      return <label key={parameter.id} className="adjustment-channel">{label}<select value={currentValue} onChange={(event) => setValue(Number(event.target.value))}>{parameter.choices.map((choice, index) => <option key={choice} value={parameter.min + index}>{localized(choice, language)}</option>)}</select></label>;
    }
    if (ANGLE_IDS.has(parameter.id)) {
      return <AngleDial key={parameter.id} className="adjustment-field" label={label} value={currentValue} min={parameter.min} max={parameter.max} onChange={setValue}/>;
    }
    return <SliderWithNumber key={parameter.id} className="adjustment-field" label={label} value={currentValue} spec={{ min: parameter.min, max: parameter.max, step: parameter.step }} onChange={setValue}/>;
  })}</>;
}
