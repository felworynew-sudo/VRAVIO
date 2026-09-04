import { useRef } from "react";

/**
 * The right-click brush tip editor — angle/roundness handles on a dial, size
 * and hardness fields, three canonical presets, and an expandable section for
 * spacing/roundness/angle as numbers. Split out of `RasterWorkspace.tsx`
 * purely to bring its own line count down (docs/migration-plan.md §8); every
 * value it edits is a plain tool option (`setToolOption`), so it needs
 * nothing from the host beyond the active tool's id and its current options.
 */
export function RasterBrushTipPopup({ activeToolId, brushOptions, position, detailed, onToggleDetailed, onClose, setToolOption }: {
  activeToolId: string;
  brushOptions: Readonly<Record<string, string | number | boolean>>;
  position: { left: number; top: number };
  detailed: boolean;
  onToggleDetailed: () => void;
  onClose: () => void;
  setToolOption: (toolId: string, optionId: string, value: string | number | boolean) => void;
}) {
  const tipDragMode = useRef<"angle" | "roundness" | null>(null);
  const tipAngle = Number(brushOptions.angle ?? 0), tipRoundness = Number(brushOptions.roundness ?? 100);
  const tipRadians = tipAngle * Math.PI / 180, tipShortRadius = 48 * tipRoundness / 100;
  const roundnessHandle = { x: 60 - Math.sin(tipRadians) * tipShortRadius, y: 60 + Math.cos(tipRadians) * tipShortRadius };
  const updateTipGeometry = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!tipDragMode.current) return;
    const rect = event.currentTarget.getBoundingClientRect(), x = (event.clientX - rect.left) * 120 / rect.width - 60, y = (event.clientY - rect.top) * 120 / rect.height - 60;
    if (tipDragMode.current === "angle") setToolOption(activeToolId, "angle", Math.round(Math.atan2(y, x) * 180 / Math.PI));
    else { const perpendicular = Math.abs(-Math.sin(tipRadians) * x + Math.cos(tipRadians) * y); setToolOption(activeToolId, "roundness", Math.max(5, Math.min(100, Math.round(perpendicular / 48 * 100)))); }
  };

  return <aside className="brush-popup" style={{ left: Math.max(6, position.left), top: Math.max(6, position.top) }} onContextMenu={(event) => event.preventDefault()}>
    <header><strong>Brush Tip (Отпечаток кисти)</strong><button onClick={onClose}>×</button></header>
    <div className="brush-tip-editor">
      <svg viewBox="0 0 120 120" onPointerMove={updateTipGeometry} onPointerUp={() => { tipDragMode.current = null; }} onPointerCancel={() => { tipDragMode.current = null; }}>
        <circle cx="60" cy="60" r="49" className="tip-guide"/>
        <ellipse cx="60" cy="60" rx="48" ry={tipShortRadius} transform={`rotate(${tipAngle} 60 60)`} className="tip-shape"/>
        <line x1="60" y1="60" x2={60 + Math.cos(tipRadians) * 48} y2={60 + Math.sin(tipRadians) * 48} className="tip-angle-line"/>
        <circle cx={60 + Math.cos(tipRadians) * 48} cy={60 + Math.sin(tipRadians) * 48} r="5" className="tip-handle" onPointerDown={(event) => { tipDragMode.current = "angle"; event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); }}/>
        <circle cx={roundnessHandle.x} cy={roundnessHandle.y} r="5" className="tip-handle" onPointerDown={(event) => { tipDragMode.current = "roundness"; event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); }}/>
      </svg>
      <div>
        <label>Size (Размер)<input type="number" min="1" max="1000" value={Number(brushOptions.size ?? 24)} onChange={(event) => setToolOption(activeToolId, "size", event.target.valueAsNumber)}/></label>
        <label>Hardness (Жёсткость)<input type="range" min="0" max="100" value={Number(brushOptions.hardness ?? 82)} onChange={(event) => setToolOption(activeToolId, "hardness", event.target.valueAsNumber)}/></label>
        <small>{tipAngle}° · {tipRoundness}%</small>
      </div>
    </div>
    <div className="brush-presets">
      <button onClick={() => { setToolOption(activeToolId, "hardness", 100); setToolOption(activeToolId, "roundness", 100); }}>●<small>Hard Round (Жёсткая круглая)</small></button>
      <button onClick={() => { setToolOption(activeToolId, "hardness", 0); setToolOption(activeToolId, "roundness", 100); }}>◉<small>Soft Round (Мягкая круглая)</small></button>
      <button onClick={() => { setToolOption(activeToolId, "hardness", 100); setToolOption(activeToolId, "roundness", 22); setToolOption(activeToolId, "angle", -25); }}>▬<small>Calligraphy (Каллиграфия)</small></button>
    </div>
    <button className="brush-details-toggle" onClick={onToggleDetailed}>{detailed ? "Hide Brush Settings (Скрыть настройки)" : "Brush Settings… (Настройки кисти…)"}</button>
    {detailed && <div className="brush-detail-fields">
      <label>Spacing (Интервал)<input type="range" min="1" max="300" value={Number(brushOptions.spacing ?? 12)} onChange={(event) => setToolOption(activeToolId, "spacing", event.target.valueAsNumber)}/><span>{Number(brushOptions.spacing ?? 12)}%</span></label>
      <label>Roundness (Округлость)<input type="range" min="5" max="100" value={tipRoundness} onChange={(event) => setToolOption(activeToolId, "roundness", event.target.valueAsNumber)}/><span>{tipRoundness}%</span></label>
      <label>Angle (Угол)<input type="range" min="-180" max="180" value={tipAngle} onChange={(event) => setToolOption(activeToolId, "angle", event.target.valueAsNumber)}/><span>{tipAngle}°</span></label>
    </div>}
  </aside>;
}
