import { AngleDial as DialControl } from "../../AngleDial";
import { NumberBox } from "./NumberBox";

/**
 * Pairs the project's own existing angle dial (`AngleDial.tsx` at the app root — already driving
 * the 3D Properties panel's rotation/light-azimuth dials, `DockLayout.tsx`) with a `NumberBox`,
 * the combination every angle-named filter parameter in the reference screenshots shows
 * (Emboss/Wind/Kaleidoscope/Color Halftone, docs/master-plan.md §51). This wraps that control
 * rather than reimplementing the drag math a second time: an earlier version of this file *did*
 * duplicate it — same `atan2`-around-centre math, same 0°=up/clockwise convention, and even the
 * same `.angle-dial` class name, which silently corrupted the 3D panel's own SVG dials once the
 * two rulesets collided in styles.css (CLAUDE.md §4 — "two futures that drift apart," found before
 * either ever shipped, by noticing the file already existed rather than after the collision
 * shipped).
 */
export function AngleDial({ label, value, min = -180, max = 180, onChange, id, className }: {
  label?: string | undefined;
  value: number;
  min?: number;
  max?: number;
  onChange(value: number): void;
  id?: string | undefined;
  className?: string | undefined;
}) {
  return <div className={["angle-dial-field", className].filter(Boolean).join(" ")}>
    {label !== undefined && label !== "" && <span className="angle-dial-label">{label}</span>}
    <DialControl value={value} min={min} max={max} onChange={onChange} size={32} {...(label !== undefined ? { title: label } : {})}/>
    <NumberBox value={value} spec={{ min, max, step: 1, unit: "°" }} onChange={onChange} id={id}/>
  </div>;
}
