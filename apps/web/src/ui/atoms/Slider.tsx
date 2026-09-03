import { applyStep, type NumberFieldSpec } from "./number-input";

/**
 * A range input that steps by the same rules a NumberBox does.
 *
 * A native range already moves on the arrow keys, but always by its own
 * `step` — there is no way to ask it for a coarser or finer grain. Since
 * Shift and Alt mean "ten times" and "a tenth" everywhere else in this
 * interface, the arrows are handled here through the same `applyStep` the
 * number field uses, so a slider and the number beside it cannot disagree
 * about what one step is.
 *
 * A double click returns the default, which is what a user arrives
 * expecting from Photoshop.
 */
export function Slider({ value, spec, defaultValue, onChange, id, className, ariaLabel }: {
  value: number;
  spec: NumberFieldSpec & { min: number; max: number };
  defaultValue?: number | undefined;
  onChange(value: number): void;
  id?: string | undefined;
  className?: string | undefined;
  ariaLabel?: string | undefined;
}) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Only take over when a modifier asks for a different grain; without one
    // the browser's own handling is already right, and leaving it alone
    // keeps every accessibility behaviour that comes with it.
    if (!event.shiftKey && !event.altKey) return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1;
    const next = applyStep(value, direction, spec, event);
    if (next !== value) onChange(next);
  };

  return <input
    id={id}
    className={["slider", className].filter(Boolean).join(" ")}
    type="range"
    min={spec.min}
    max={spec.max}
    step={spec.step ?? 1}
    value={value}
    aria-label={ariaLabel}
    onKeyDown={onKeyDown}
    onDoubleClick={() => { if (defaultValue !== undefined && defaultValue !== value) onChange(defaultValue); }}
    onChange={(event) => onChange(event.target.valueAsNumber)}
  />;
}
