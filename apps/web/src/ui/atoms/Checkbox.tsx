export function Checkbox({ label, checked, onChange, id, className }: {
  label?: string | undefined;
  checked: boolean;
  onChange(checked: boolean): void;
  id?: string | undefined;
  className?: string | undefined;
}) {
  return <label className={["checkbox", className].filter(Boolean).join(" ")}>
    <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    {label !== undefined && label !== "" && <span>{label}</span>}
  </label>;
}
