import { useRef } from "react";

/**
 * A small circular knob — drag the handle around the ring to set a value
 * across `[min, max]`, mapped to a full turn starting at 12 o'clock and
 * going clockwise. The owner's own sketch for the 3D Properties panel:
 * three of these for the object's own X/Y/Z rotation, three more for the
 * light's azimuth/elevation/intensity, in place of the plain linear
 * sliders those used to be.
 *
 * The drag math is the same `atan2` around the control's own centre
 * `RasterBrushTipPopup.tsx`'s own angle handle already uses for the brush
 * tip's angle — a dial is a dial, this just generalises it to an arbitrary
 * `[min, max]` (the brush tip's own handle is fixed to a full -180..180)
 * rather than becoming a third hand-rolled copy of the same trig.
 *
 * Unlike the brush tip's own handle (a small circle that is the *only* hit
 * target, deliberately, since that popup has two independent handles
 * sharing one dial and a bigger hit area would make them fight over
 * clicks), a whole-disc pointerdown starts the drag here: at this control's
 * own size there is only ever one handle, so there is nothing a generous
 * hit area could conflict with, and requiring a precise grab on a ~7px dot
 * is a real miss-and-retry cost for something this small.
 */
export function AngleDial({ value, min, max, onChange, size = 40, title }: {
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
  size?: number;
  title?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const radius = size / 2 - 6;
  const center = size / 2;
  const fraction = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angleRad = (fraction * 360 - 90) * Math.PI / 180;
  const handleX = center + Math.cos(angleRad) * radius, handleY = center + Math.sin(angleRad) * radius;

  const valueFromPointer = (clientX: number, clientY: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = (clientX - rect.left) * size / rect.width - center, y = (clientY - rect.top) * size / rect.height - center;
    let angleDeg = Math.atan2(y, x) * 180 / Math.PI + 90;
    if (angleDeg < 0) angleDeg += 360;
    return Math.round(min + (angleDeg / 360) * (max - min));
  };

  const dial = <svg ref={svgRef} viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="angle-dial"
    onPointerDown={(event) => {
      dragging.current = true;
      svgRef.current?.setPointerCapture(event.pointerId);
      const next = valueFromPointer(event.clientX, event.clientY);
      if (next !== null) onChange(next);
    }}
    onPointerMove={(event) => { if (!dragging.current) return; const next = valueFromPointer(event.clientX, event.clientY); if (next !== null) onChange(next); }}
    onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}>
    <circle cx={center} cy={center} r={radius} className="angle-dial-ring"/>
    <line x1={center} y1={center} x2={handleX} y2={handleY} className="angle-dial-needle"/>
    <circle cx={handleX} cy={handleY} r={3.5} className="angle-dial-handle"/>
  </svg>;

  return title ? <span title={title}>{dial}</span> : dial;
}
