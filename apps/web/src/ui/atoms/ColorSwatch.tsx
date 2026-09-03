export function ColorSwatch({ label, value, onChange, id, className, title }: {
  label?: string | undefined;
  value: string;
  onChange(value: string): void;
  id?: string | undefined;
  className?: string | undefined;
  title?: string | undefined;
}) {
  return <label className={["color-swatch", className].filter(Boolean).join(" ")} title={title}>
    {label !== undefined && label !== "" && <span>{label}</span>}
    <input id={id} type="color" value={value} onChange={(event) => onChange(event.target.value)} />
  </label>;
}
