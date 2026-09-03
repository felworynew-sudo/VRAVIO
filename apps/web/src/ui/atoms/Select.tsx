export interface SelectChoice { readonly value: string; readonly label: string }

export function Select({ label, value, choices, onChange, id, className }: {
  label?: string | undefined;
  value: string;
  choices: readonly SelectChoice[];
  onChange(value: string): void;
  id?: string | undefined;
  className?: string | undefined;
}) {
  return <label className={["select-field", className].filter(Boolean).join(" ")}>
    {label !== undefined && label !== "" && <span>{label}</span>}
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
    </select>
  </label>;
}
