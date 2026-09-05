import {
  colorPaint, solidFill, solidStroke,
  type FillLayer, type Gradient, type Paint, type StrokeCap, type StrokeJoin, type StrokeLayer, type VectorStyle,
} from "@vravio/env-vector";
import { colorToCss, colorToHex, cssToColor, srgb } from "@vravio/kernel";
import { text } from "../../i18n";
import type { Language } from "../../store";

/**
 * Stage 6 of docs/vector-plan.md: "an object looks like it does in
 * Illustrator, not one fill and one line" — the properties-panel half of
 * that, alongside `@vravio/env-vector`'s `appearance.ts` (the data) and
 * `VectorWorkspace.tsx`'s `renderShape` (the render). Kept in its own file
 * rather than inline in `DockLayout.tsx`, which was already the largest
 * file this stage would otherwise have made larger still.
 */

const blendModes = ["normal", "dissolve", "darken", "multiply", "colorBurn", "linearBurn", "darkerColor", "lighten", "screen", "colorDodge", "linearDodge", "lighterColor", "overlay", "softLight", "hardLight", "vividLight", "linearLight", "pinLight", "hardMix", "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity"] as const;

function moveItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function defaultGradient(): Gradient {
  return { kind: "linear", stops: [{ offset: 0, color: srgb(0, 0, 0) }, { offset: 1, color: srgb(255, 255, 255) }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
}

function GradientEditor({ gradient, onChange }: { gradient: Gradient; onChange(next: Gradient): void }) {
  const setStops = (stops: Gradient["stops"]) => onChange({ ...gradient, stops });
  const preview = `linear-gradient(90deg, ${gradient.stops.map((stop) => `${colorToCss(stop.color)} ${Math.round(stop.offset * 100)}%`).join(", ")})`;
  return <div className="gradient-editor">
    <div className="parameter-pair">
      <select value={gradient.kind} onChange={(event) => onChange({ ...gradient, kind: event.target.value as Gradient["kind"] })}>
        <option value="linear">Linear</option>
        <option value="radial">Radial</option>
      </select>
      <span className="gradient-preview" style={{ background: preview }}/>
    </div>
    {gradient.stops.map((stop, index) => <div className="gradient-stop-row" key={index}>
      <input type="color" value={colorToHex(stop.color)} onChange={(event) => setStops(gradient.stops.map((item, i) => i === index ? { ...item, color: cssToColor(event.target.value) } : item))}/>
      <input type="number" min={0} max={100} value={Math.round(stop.offset * 100)} onChange={(event) => setStops(gradient.stops.map((item, i) => i === index ? { ...item, offset: Math.max(0, Math.min(1, event.target.valueAsNumber / 100)) } : item))}/>
      <button className="gradient-stop-remove" disabled={gradient.stops.length <= 2} onClick={() => setStops(gradient.stops.filter((_, i) => i !== index))}>×</button>
    </div>)}
    <button className="secondary-action" onClick={() => setStops([...gradient.stops, { offset: 1, color: srgb(0, 0, 0) }])}>+ Stop</button>
  </div>;
}

function PaintEditor({ paint, onChange }: { paint: Paint; onChange(next: Paint): void }) {
  return <div className="paint-editor">
    <select value={paint.kind} onChange={(event) => onChange(event.target.value === "gradient" ? { kind: "gradient", gradient: defaultGradient() } : colorPaint(paint.kind === "gradient" ? paint.gradient.stops[0]?.color ?? srgb(0, 0, 0) : srgb(0, 0, 0)))}>
      <option value="color">Color</option>
      <option value="gradient">Gradient</option>
    </select>
    {paint.kind === "color"
      ? <input type="color" value={colorToHex(paint.color)} onChange={(event) => onChange(colorPaint(cssToColor(event.target.value)))}/>
      : <GradientEditor gradient={paint.gradient} onChange={(gradient) => onChange({ kind: "gradient", gradient })}/>}
  </div>;
}

interface LayerRowProps<TLayer> {
  layer: TLayer;
  onChange(next: TLayer): void;
  onRemove(): void;
  onMove(direction: -1 | 1): void;
  isFirst: boolean;
  isLast: boolean;
}

function FillRow({ layer, onChange, onRemove, onMove, isFirst, isLast }: LayerRowProps<FillLayer>) {
  return <div className="appearance-row">
    <input type="checkbox" checked={layer.visible} onChange={(event) => onChange({ ...layer, visible: event.target.checked })} title="Visible"/>
    <PaintEditor paint={layer.paint} onChange={(paint) => onChange({ ...layer, paint })}/>
    <input className="appearance-opacity" type="number" min={0} max={100} value={Math.round(layer.opacity * 100)} onChange={(event) => onChange({ ...layer, opacity: Math.max(0, Math.min(1, event.target.valueAsNumber / 100)) })}/>
    <button disabled={isFirst} onClick={() => onMove(-1)} aria-label="Move up">↑</button>
    <button disabled={isLast} onClick={() => onMove(1)} aria-label="Move down">↓</button>
    <button className="appearance-row-remove" onClick={onRemove} aria-label="Remove">×</button>
  </div>;
}

function StrokeRow({ layer, onChange, onRemove, onMove, isFirst, isLast }: LayerRowProps<StrokeLayer>) {
  return <div className="appearance-row appearance-row-stroke">
    <div className="appearance-row">
      <input type="checkbox" checked={layer.visible} onChange={(event) => onChange({ ...layer, visible: event.target.checked })} title="Visible"/>
      <PaintEditor paint={layer.paint} onChange={(paint) => onChange({ ...layer, paint })}/>
      <input className="appearance-opacity" type="number" min={0} max={100} value={Math.round(layer.opacity * 100)} onChange={(event) => onChange({ ...layer, opacity: Math.max(0, Math.min(1, event.target.valueAsNumber / 100)) })}/>
      <button disabled={isFirst} onClick={() => onMove(-1)} aria-label="Move up">↑</button>
      <button disabled={isLast} onClick={() => onMove(1)} aria-label="Move down">↓</button>
      <button className="appearance-row-remove" onClick={onRemove} aria-label="Remove">×</button>
    </div>
    <div className="appearance-row appearance-stroke-details">
      <label>W<input type="number" min={0} value={layer.width} onChange={(event) => onChange({ ...layer, width: Math.max(0, event.target.valueAsNumber) })}/></label>
      <select value={layer.dash.length ? "dashed" : "solid"} onChange={(event) => onChange({ ...layer, dash: event.target.value === "dashed" ? [layer.width * 2 || 4, layer.width * 2 || 4] : [] })}>
        <option value="solid">Solid</option>
        <option value="dashed">Dashed</option>
      </select>
      <select value={layer.cap} onChange={(event) => onChange({ ...layer, cap: event.target.value as StrokeCap })}>
        <option value="butt">Butt</option><option value="round">Round</option><option value="square">Square</option>
      </select>
      <select value={layer.join} onChange={(event) => onChange({ ...layer, join: event.target.value as StrokeJoin })}>
        <option value="miter">Miter</option><option value="round">Round</option><option value="bevel">Bevel</option>
      </select>
    </div>
  </div>;
}

export function AppearancePanel({ style, language, onChange }: { style: VectorStyle; language: Language; onChange(next: VectorStyle): void }) {
  const setFills = (fills: FillLayer[]) => onChange({ ...style, fills });
  const setStrokes = (strokes: StrokeLayer[]) => onChange({ ...style, strokes });

  return <div className="appearance-panel">
    <div className="appearance-section">
      <div className="appearance-section-header"><span>{text(language, "Fills", "Заливки")}</span><button onClick={() => setFills([...style.fills, solidFill(srgb(0x5b, 0xe0, 0xb3))])}>+</button></div>
      {style.fills.map((fill, index) => <FillRow key={fill.id} layer={fill} isFirst={index === 0} isLast={index === style.fills.length - 1}
        onChange={(next) => setFills(style.fills.map((item, i) => i === index ? next : item))}
        onRemove={() => setFills(style.fills.filter((_, i) => i !== index))}
        onMove={(direction) => setFills(moveItem(style.fills, index, direction))}/>)}
      {!style.fills.length && <p className="appearance-empty">{text(language, "No fill", "Без заливки")}</p>}
    </div>
    <div className="appearance-section">
      <div className="appearance-section-header"><span>{text(language, "Strokes", "Обводки")}</span><button onClick={() => setStrokes([...style.strokes, solidStroke(srgb(0, 0, 0))])}>+</button></div>
      {style.strokes.map((stroke, index) => <StrokeRow key={stroke.id} layer={stroke} isFirst={index === 0} isLast={index === style.strokes.length - 1}
        onChange={(next) => setStrokes(style.strokes.map((item, i) => i === index ? next : item))}
        onRemove={() => setStrokes(style.strokes.filter((_, i) => i !== index))}
        onMove={(direction) => setStrokes(moveItem(style.strokes, index, direction))}/>)}
      {!style.strokes.length && <p className="appearance-empty">{text(language, "No stroke", "Без обводки")}</p>}
    </div>
    <label>{text(language, "Blend Mode", "Режим наложения")}<select value={style.blendMode} onChange={(event) => onChange({ ...style, blendMode: event.target.value as VectorStyle["blendMode"] })}>{blendModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>
    <label>{text(language, "Opacity", "Непрозрачность")}<input type="range" min={0} max={100} value={Math.round(style.opacity * 100)} onChange={(event) => onChange({ ...style, opacity: event.target.valueAsNumber / 100 })}/></label>
  </div>;
}
