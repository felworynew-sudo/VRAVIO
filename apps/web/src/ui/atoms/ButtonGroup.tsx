/**
 * A labelled row of segmented buttons — Patchy's own "Технику: Wind Blast
 * Stagger" style for a filter's either/or choice (docs/master-plan.md §51),
 * distinct from the plain-select `Select` atom: Patchy's dialogs use this
 * button-row look for a filter's primary style/technique/direction choice
 * and a dropdown only for a longer list (Palette, Mezzotint's ten types).
 * Reproduced here rather than the radio-with-a-label rows the adjustment
 * dialogs already use, which read as a list of options, not one control.
 */
export function ButtonGroup<T extends string>({ label, value, options, onChange, id, className }: {
  label?: string | undefined;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  id?: string | undefined;
  className?: string | undefined;
}) {
  return <div className={["button-group", className].filter(Boolean).join(" ")} id={id} role="group" aria-label={label}>
    {label !== undefined && label !== "" && <span className="button-group-label">{label}</span>}
    <span className="button-group-options">
      {options.map((option) => <button
        key={option.value}
        type="button"
        className={option.value === value ? "active" : ""}
        aria-pressed={option.value === value}
        onClick={() => onChange(option.value)}
      >{option.label}</button>)}
    </span>
  </div>;
}
