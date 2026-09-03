import { NumberBox } from "../atoms/NumberBox";
import { Slider } from "../atoms/Slider";
import type { NumberFieldSpec } from "../atoms/number-input";

/**
 * A slider and the number it is showing, driving one value.
 *
 * Both halves read the same `spec`, so the slider's step, the arrow keys and
 * the typed unit all agree by construction rather than by two call sites
 * happening to pass matching numbers.
 */
export function SliderWithNumber({ label, value, spec, defaultValue, onChange, className }: {
  label?: string | undefined;
  value: number;
  spec: NumberFieldSpec & { min: number; max: number };
  defaultValue?: number | undefined;
  onChange(value: number): void;
  className?: string | undefined;
}) {
  return <div className={["slider-with-number", className].filter(Boolean).join(" ")}>
    {label !== undefined && label !== "" && <span className="slider-with-number-label">{label}</span>}
    <Slider value={value} spec={spec} defaultValue={defaultValue} onChange={onChange} ariaLabel={label} />
    <NumberBox value={value} spec={spec} onChange={onChange} />
  </div>;
}
