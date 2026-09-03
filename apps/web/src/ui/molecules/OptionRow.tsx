import { Checkbox } from "../atoms/Checkbox";
import { ColorSwatch } from "../atoms/ColorSwatch";
import { NumberBox } from "../atoms/NumberBox";
import { Select } from "../atoms/Select";
import { resolveLabel } from "../../i18n";
import type { Language } from "../../store";
import type { ToolOption } from "../../tools";

/**
 * One entry of a tool's options bar, chosen by the option's own type.
 *
 * This is the only place that maps a `ToolOption` to a control, so a new
 * option type is one arm added here and nothing else — and, more to the
 * point, an existing type cannot be rendered two different ways by two
 * panels that both grew their own version of this switch.
 */
export function OptionRow({ option, value, language, pixelsPerInch, onChange }: {
  option: ToolOption;
  value: string | number | boolean;
  language: Language;
  /** Document resolution, so a length typed as "2 cm" resolves to pixels. */
  pixelsPerInch?: number | undefined;
  onChange(value: string | number | boolean): void;
}) {
  const label = resolveLabel(option.label, language);

  if (option.type === "boolean") {
    return <Checkbox className="option-field check" label={label} checked={Boolean(value)} onChange={onChange} />;
  }
  if (option.type === "select") {
    return <Select
      className="option-field"
      label={label}
      value={String(value)}
      choices={option.values.map((item) => ({ value: item.value, label: resolveLabel(item.label, language) }))}
      onChange={onChange}
    />;
  }
  if (option.type === "color") {
    return <ColorSwatch className="option-field color-field" label={label} value={String(value)} onChange={onChange} />;
  }
  return <NumberBox
    className="option-field"
    label={label}
    value={Number(value)}
    spec={{ min: option.min, max: option.max, step: option.step, unit: option.unit, pixelsPerInch }}
    onChange={onChange}
  />;
}
