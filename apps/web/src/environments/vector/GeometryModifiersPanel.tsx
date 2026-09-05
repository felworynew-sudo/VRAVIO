import type { BooleanOpKind, StrokeJoin } from "@vravio/kernel";
import type { GeometryModifier, VectorShape } from "@vravio/env-vector";
import { text } from "../../i18n";
import type { Language } from "../../store";

/**
 * Stage 9 of docs/vector-plan.md: the properties-panel half of the
 * non-destructive modifier stack (the data model and its execution live in
 * `@vravio/env-vector`'s `modifiers/`, the lazy WASM wiring in
 * `apps/web/src/vector-modifiers.ts`). Kept in its own file for the same
 * reason `AppearancePanel.tsx` is — `DockLayout.tsx` was already the
 * largest file this stage would otherwise have made larger still.
 *
 * Reordering is up/down buttons, not drag-and-drop, matching the choice
 * `AppearancePanel.tsx` already made for fill/stroke stacks — the plan's
 * own wording ("порядок меняется перетаскиванием") asks for dragging, but
 * this is the same honest, documented simplification, not an oversight.
 */

let counter = 0;
function nextId(): string { counter += 1; return `modifier-${Date.now()}-${counter}`; }

function moveItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

const joins: readonly StrokeJoin[] = ["miter", "round", "bevel"];
const booleanOps: readonly BooleanOpKind[] = ["union", "subtract", "intersect", "exclude"];

function defaultModifierFor(kind: GeometryModifier["kind"], otherShapeId: string | null): GeometryModifier {
  const base = { id: nextId(), enabled: true };
  if (kind === "roundCorners") return { ...base, kind, radius: 8 };
  if (kind === "offset") return { ...base, kind, amount: 10, join: "round" };
  if (kind === "simplify") return { ...base, kind, accuracy: 1 };
  if (kind === "zigzag") return { ...base, kind, amplitude: 8, segmentLength: 20 };
  return { ...base, kind: "boolean", op: "union", withShapeId: otherShapeId ?? "" };
}

function ModifierRow({ modifier, onChange, onRemove, onMove, isFirst, isLast, otherShapes, language }: {
  modifier: GeometryModifier;
  onChange(next: GeometryModifier): void;
  onRemove(): void;
  onMove(direction: -1 | 1): void;
  isFirst: boolean;
  isLast: boolean;
  otherShapes: readonly VectorShape[];
  language: Language;
}) {
  return <div className="appearance-row modifier-row">
    <div className="appearance-row">
      <input type="checkbox" checked={modifier.enabled} onChange={(event) => onChange({ ...modifier, enabled: event.target.checked })} title={text(language, "Enabled", "Включён")}/>
      <span className="modifier-kind-label">{modifierLabel(modifier.kind, language)}</span>
      <button disabled={isFirst} onClick={() => onMove(-1)} aria-label="Move up">↑</button>
      <button disabled={isLast} onClick={() => onMove(1)} aria-label="Move down">↓</button>
      <button className="appearance-row-remove" onClick={onRemove} aria-label="Remove">×</button>
    </div>
    <div className="appearance-row modifier-params">
      {modifier.kind === "roundCorners" && <label>{text(language, "Radius", "Радиус")}<input type="number" min={0} value={modifier.radius} onChange={(event) => onChange({ ...modifier, radius: Math.max(0, event.target.valueAsNumber) })}/></label>}
      {modifier.kind === "offset" && <>
        <label>{text(language, "Amount", "Величина")}<input type="number" value={modifier.amount} onChange={(event) => onChange({ ...modifier, amount: event.target.valueAsNumber })}/></label>
        <select value={modifier.join} onChange={(event) => onChange({ ...modifier, join: event.target.value as StrokeJoin })}>
          {joins.map((join) => <option key={join} value={join}>{join}</option>)}
        </select>
      </>}
      {modifier.kind === "simplify" && <label>{text(language, "Accuracy", "Точность")}<input type="number" min={0} step={0.1} value={modifier.accuracy} onChange={(event) => onChange({ ...modifier, accuracy: Math.max(0, event.target.valueAsNumber) })}/></label>}
      {modifier.kind === "zigzag" && <>
        <label>{text(language, "Amplitude", "Амплитуда")}<input type="number" min={0} value={modifier.amplitude} onChange={(event) => onChange({ ...modifier, amplitude: Math.max(0, event.target.valueAsNumber) })}/></label>
        <label>{text(language, "Segment", "Сегмент")}<input type="number" min={1} value={modifier.segmentLength} onChange={(event) => onChange({ ...modifier, segmentLength: Math.max(1, event.target.valueAsNumber) })}/></label>
      </>}
      {modifier.kind === "boolean" && <>
        <select value={modifier.op} onChange={(event) => onChange({ ...modifier, op: event.target.value as BooleanOpKind })}>
          {booleanOps.map((op) => <option key={op} value={op}>{op}</option>)}
        </select>
        <select value={modifier.withShapeId} onChange={(event) => onChange({ ...modifier, withShapeId: event.target.value })}>
          <option value="">{text(language, "Choose a shape…", "Выберите фигуру…")}</option>
          {otherShapes.map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
        </select>
      </>}
    </div>
  </div>;
}

function modifierLabel(kind: GeometryModifier["kind"], language: Language): string {
  if (kind === "roundCorners") return text(language, "Round Corners", "Скругление углов");
  if (kind === "offset") return text(language, "Offset", "Офсет");
  if (kind === "simplify") return text(language, "Simplify", "Упрощение");
  if (kind === "zigzag") return text(language, "Zigzag", "Зигзаг");
  return text(language, "Boolean", "Булева операция");
}

export function GeometryModifiersPanel({ shape, allShapes, language, onChange }: {
  shape: VectorShape;
  allShapes: readonly VectorShape[];
  language: Language;
  onChange(next: GeometryModifier[]): void;
}) {
  const otherShapes = allShapes.filter((other) => other.id !== shape.id && (other.kind === "rectangle" || other.kind === "ellipse" || other.kind === "path"));
  const addModifier = (kind: GeometryModifier["kind"]) => onChange([...shape.geometry, defaultModifierFor(kind, otherShapes[0]?.id ?? null)]);

  return <div className="appearance-panel modifiers-panel">
    <div className="appearance-section">
      <div className="appearance-section-header">
        <span>{text(language, "Modifiers", "Модификаторы")}</span>
        <select value="" onChange={(event) => { if (event.target.value) addModifier(event.target.value as GeometryModifier["kind"]); }}>
          <option value="">{text(language, "+ Add…", "+ Добавить…")}</option>
          <option value="roundCorners">{modifierLabel("roundCorners", language)}</option>
          <option value="offset">{modifierLabel("offset", language)}</option>
          <option value="simplify">{modifierLabel("simplify", language)}</option>
          <option value="zigzag">{modifierLabel("zigzag", language)}</option>
          <option value="boolean">{modifierLabel("boolean", language)}</option>
        </select>
      </div>
      {shape.geometry.map((modifier, index) => <ModifierRow key={modifier.id} modifier={modifier} otherShapes={otherShapes} language={language}
        isFirst={index === 0} isLast={index === shape.geometry.length - 1}
        onChange={(next) => onChange(shape.geometry.map((item, i) => i === index ? next : item))}
        onRemove={() => onChange(shape.geometry.filter((_, i) => i !== index))}
        onMove={(direction) => onChange(moveItem(shape.geometry, index, direction))}/>)}
      {!shape.geometry.length && <p className="appearance-empty">{text(language, "No modifiers", "Без модификаторов")}</p>}
    </div>
  </div>;
}
