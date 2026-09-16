import { useRef } from "react";
import { NumberBox } from "./NumberBox";

/**
 * A draggable circular angle control paired with its own numeric field —
 * Patchy's own control for Emboss/Motion Blur/Twirl/Lens Blur Rotation/Iris
 * Blur/Tilt-Shift's angle parameters (docs/master-plan.md §51's donor
 * research: `filter_gallery_controls.cpp`'s "angle dial ... synced with the
 * numeric controls"), not a plain slider — a slider cannot represent "drag
 * around a circle" at all, and every one of these screenshots shows the
 * dial specifically for angle parameters, never for a plain magnitude.
 *
 * 0° points up (the twelve-o'clock convention every one of the reference
 * screenshots shows); increasing angle is clockwise, matching a compass
 * reading rather than mathematical convention, since these are all visual
 * rotation controls a user drags with their eyes, not a trig call site.
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
  const dialRef = useRef<HTMLDivElement>(null);

  const angleFromEvent = (event: { clientX: number; clientY: number }): number => {
    const dial = dialRef.current;
    if (!dial) return value;
    const rect = dial.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX, dy = event.clientY - centerY;
    // atan2(dx, -dy): zero straight up, clockwise-positive — the compass reading the dial shows.
    let degrees = Math.atan2(dx, -dy) * 180 / Math.PI;
    if (degrees < min) degrees += 360; else if (degrees > max) degrees -= 360;
    return Math.max(min, Math.min(max, Math.round(degrees)));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    onChange(angleFromEvent(event));
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onChange(angleFromEvent(event));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div className={["angle-dial-field", className].filter(Boolean).join(" ")}>
    {label !== undefined && label !== "" && <span className="angle-dial-label">{label}</span>}
    <div
      ref={dialRef}
      className="angle-dial"
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      id={id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); onChange(Math.min(max, value + 1)); }
        else if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); onChange(Math.max(min, value - 1)); }
      }}
    >
      <div className="angle-dial-hand" style={{ transform: `rotate(${value}deg)` }}/>
    </div>
    <NumberBox value={value} spec={{ min, max, step: 1, unit: "°" }} onChange={onChange}/>
  </div>;
}
