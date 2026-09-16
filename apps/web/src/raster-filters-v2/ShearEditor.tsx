import { text } from "../i18n";
import type { FilterPanelEditorProps } from "./types";

const POINT_COUNT = 5;
const BOX_WIDTH = 120, BOX_HEIGHT = 200, MARGIN = 6;

/**
 * Shear's real widget, per the reference screenshot (docs/master-plan.md §51): a draggable
 * vertical curve, not an Amount slider — `shearFilter` reads this same five-point shape
 * (`point0`..`point4`, evenly spaced top-to-bottom) through a Catmull-Rom spline. Reuses
 * `AdjustmentEditor.tsx`'s own `.curve-graph`/`.curve-baseline`/`.curve-line` styling outright
 * (CLAUDE.md §4 — one visual language for "a draggable curve" in this app, not a second one that
 * happens to look similar) and `AngleDial.tsx`'s own pointer-capture pattern for the handles,
 * just rotated: Curves drags a point vertically along a fixed horizontal axis, this drags a point
 * horizontally along a fixed vertical axis.
 */
export function ShearEditor({ settings, language, onChange }: FilterPanelEditorProps) {
  const points = Array.from({ length: POINT_COUNT }, (_, index) => Number.isFinite(settings[`point${index}`]) ? settings[`point${index}`]! : 0);
  const halfWidth = BOX_WIDTH / 2 - MARGIN, midX = BOX_WIDTH / 2;
  const yFor = (index: number) => (index / (POINT_COUNT - 1)) * BOX_HEIGHT;
  const xFor = (value: number) => midX + (value / 100) * halfWidth;
  const valueFromClientX = (svg: SVGSVGElement, clientX: number) => {
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * BOX_WIDTH;
    return Math.max(-100, Math.min(100, Math.round(((x - midX) / halfWidth) * 100)));
  };
  const setPoint = (index: number, value: number) => onChange({ ...settings, [`point${index}`]: value });
  const path = points.map((value, index) => `${index ? "L" : "M"}${xFor(value)} ${yFor(index)}`).join(" ");

  return <div className="adjustment-field shear-curve-field">
    <span className="slider-with-number-label">{text(language, "Curve", "Кривая")}</span>
    <div className="curve-graph shear-curve-graph">
      <svg viewBox={`0 0 ${BOX_WIDTH} ${BOX_HEIGHT}`} preserveAspectRatio="none">
        <line x1={midX} y1={0} x2={midX} y2={BOX_HEIGHT} className="curve-baseline"/>
        <path d={path} className="curve-line"/>
        {points.map((value, index) => <circle
          key={index}
          cx={xFor(value)} cy={yFor(index)} r={5}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setPoint(index, valueFromClientX(event.currentTarget.ownerSVGElement!, event.clientX)); }}
          onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; setPoint(index, valueFromClientX(event.currentTarget.ownerSVGElement!, event.clientX)); }}
          onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        />)}
      </svg>
    </div>
    <button type="button" onClick={() => onChange(Object.fromEntries(points.map((_, index) => [`point${index}`, 0])))}>{text(language, "Straighten", "Выпрямить")}</button>
  </div>;
}
