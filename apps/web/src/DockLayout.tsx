import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { DockviewReact, themeDark, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from "dockview-react";
import type { DockviewReadyEvent, SerializedDockview } from "dockview";
import { environmentMeta } from "./environment";
import { useShellStore } from "./store";
import { useDocuments } from "./useDocuments";
import { RasterWorkspace } from "./RasterWorkspace";
import { appendLayer, appendRasterGroup, compositeRasterDocument, createAdjustmentLayer, createRasterLayer, createRasterLayerMask, isRasterDocumentState, rasterLayerDescendantIds, rasterLayerRows, setLayerPixels, dropPositionInRow, dropTargetForRow, placeLayer, toggleLayerLink, type RasterBlendMode, type RasterDocumentState, type RasterLayer, type RasterLayerMask } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { localized, text } from "./i18n";
import { renderTextLayerPixels } from "./textRender";
import { ColorPanel } from "./ColorPanel";
import { NavigatorPanel } from "./NavigatorPanel";
import type { Language } from "./store";
import { rasterAdjustmentById, rasterAdjustments } from "./raster-adjustments/registry";
import { rasterCorePanelById, rasterCorePanels } from "./raster-core-panels/registry";
import { corePanelTitle } from "./raster-core-panels/types";
import { PANEL_REQUEST_EVENT, persistVisiblePanelIds, readVisiblePanelIds } from "./raster-core-panels/runtime";
import { luminanceHistogram } from "./raster-adjustments/histogram";
import { changeRasterDocument } from "./commands";
import type { ReversibleOperation } from "@vravio/kernel";
import "dockview-react/dist/styles/dockview.css";

/**
 * A history step for a continuous edit — dragging a curve point, scrubbing a slider — that
 * merges with its own immediate predecessor. The document updates on every call so the edit
 * stays live, but undo steps back to before the whole editing session started instead of one
 * micro-step per pixel of drag. `HistoryManager.record`'s `merge` flag drives this; nothing
 * in this codebase used `mergeWith` before adjustment-layer editing needed it.
 */
function mergeableEdit(label: string, undo: () => void, redo: () => void): ReversibleOperation {
  return { label, undo, redo, mergeWith: (next) => next.label === label ? mergeableEdit(label, undo, next.redo) : null };
}

const LAYOUT_STORAGE_KEY = "vravio.workspace.default.v5";
const EMPTY_LAYER_SELECTION: string[] = [];
const MediaWorkspace = lazy(() => import("./MediaWorkspace").then((module) => ({ default: module.MediaWorkspace })));

function ViewportPanel() {
  const documents = useDocuments();
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const language = useShellStore((state) => state.language);
  const active = documents.find((document) => document.id === activeDocumentId) ?? null;

  if (!active) return null;
  if (active.kind === "raster") return <RasterWorkspace document={active} />;
  if (active.kind === "audio" || active.kind === "video") return <Suspense fallback={<div className="media-empty">Loading media workspace… (Загрузка медиа-среды…)</div>}><MediaWorkspace kind={active.kind} language={language}/></Suspense>;
  const meta = environmentMeta[active.kind];
  return <div className="environment-placeholder" data-kind={active.kind}><div className="canvas"><EnvironmentIcon kind={active.kind} className="placeholder-environment-icon" /><h2>{localized(active.name, language)}</h2><p>{language === "ru" ? meta.descriptionRu : meta.description}</p><small>{text(language, "Workspace kernel connected · renderer arrives in the next verified slice", "Ядро рабочей среды подключено · визуальный движок появится в следующем проверенном срезе")}</small></div></div>;
}

function InspectorPanel({ params }: IDockviewPanelProps<{ kind?: string }>) {
  const language = useShellStore((state) => state.language);
  const documents = useDocuments();
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const document = documents.find((item) => item.id === activeDocumentId);
  if (document && isRasterDocumentState(document.state)) {
    const rasterState = document.state;
    const layer = rasterState.layers.find((item) => item.id === rasterState.activeLayerId);
    if (layer?.kind === "text" && layer.text) {
      const updateText = (patch: Partial<NonNullable<RasterLayer["text"]>>) => kernel.documents.update<RasterDocumentState>(document.id, (state) => { const current = state.layers.find((item) => item.id === state.activeLayerId); if (!current?.text) return; current.text = { ...current.text, ...patch }; rasterizeTextLayer(current, state.width, state.height); });
      return <div className="dock-panel-body property-stack"><strong>Type Properties (Свойства текста)</strong><label>Text (Текст)<textarea value={layer.text.value} onChange={(event) => updateText({ value: event.target.value })} /></label><label>Type (Тип)<select value={layer.text.mode ?? (layer.text.boxWidth ? "area" : "point")} onChange={(event) => updateText({ mode: event.target.value as "point" | "area" | "path" | "dynamic" })}><option value="point">Point text (Точечный)</option><option value="area">Paragraph text (Блочный)</option>{layer.text.path && <option value="path">Text on path (Текст по контуру)</option>}{layer.text.path && <option value="dynamic">Dynamic text (Динамический)</option>}</select></label>{layer.text.mode === "dynamic" && <label>Dynamic shape (Динамическая форма)<select value={layer.text.dynamicPreset ?? "arch"} onChange={(event) => updateText({ dynamicPreset: event.target.value as "circle" | "arch" | "bow" })}><option value="circle">Circle (Круг)</option><option value="arch">Arch (Дуга)</option><option value="bow">Bow (Изгиб)</option></select></label>}{layer.text.path && <label className="export-check"><input type="checkbox" checked={layer.text.path.flip ?? false} onChange={(event) => updateText({ path: { ...layer.text!.path!, flip: event.target.checked } })}/>Flip path (Перевернуть контур)</label>}<label>Font (Шрифт)<input value={layer.text.fontFamily} onChange={(event) => updateText({ fontFamily: event.target.value })} /></label><label>Size (Кегль)<input type="number" min="1" max="1000" value={layer.text.fontSize} onChange={(event) => updateText({ fontSize: event.target.valueAsNumber })} /></label><label>Leading (Межстрочный)<input type="number" min="0.5" max="5" step="0.05" value={layer.text.lineHeight} onChange={(event) => updateText({ lineHeight: event.target.valueAsNumber })} /></label><label>Tracking (Межбуквенный)<input type="number" min="-50" max="200" value={layer.text.letterSpacing} onChange={(event) => updateText({ letterSpacing: event.target.valueAsNumber })} /></label><label>Align (Выравнивание)<select value={layer.text.align} onChange={(event) => updateText({ align: event.target.value as "left" | "center" | "right" })}><option value="left">Left (Слева)</option><option value="center">Center (По центру)</option><option value="right">Right (Справа)</option></select></label><label>Color (Цвет)<input type="color" value={layer.text.color} onChange={(event) => updateText({ color: event.target.value })} /></label><div className="text-style-toggles"><button className={layer.text.bold ? "active" : ""} onClick={() => updateText({ bold: !layer.text?.bold })} title="Bold (Полужирный)"><b>B</b></button><button className={layer.text.italic ? "active" : ""} onClick={() => updateText({ italic: !layer.text?.italic })} title="Italic (Курсив)"><i>I</i></button><button className={layer.text.underline ? "active" : ""} onClick={() => updateText({ underline: !layer.text?.underline })} title="Underline (Подчёркнутый)"><u>U</u></button></div></div>;
    }
    if (layer?.kind === "adjustment" && layer.adjustment) {
      const adjustment = layer.adjustment;
      const definition = rasterAdjustmentById.get(adjustment.kind);
      if (definition) { const index = rasterState.layers.findIndex((item) => item.id === layer.id), pixels = compositeRasterDocument({ ...rasterState, layers: rasterState.layers.slice(0, Math.max(0, index)) }); return <div className="dock-panel-body property-stack adjustment-properties"><header><img src={definition.icon} alt=""/><strong>{language === "ru" ? definition.name.ru : definition.name.en}</strong></header><definition.Editor value={adjustment} language={language} histogram={luminanceHistogram(pixels)} onChange={(next) => { const before = adjustment, targetId = layer.id; const write = (value: typeof adjustment) => kernel.documents.update<RasterDocumentState>(document.id, (state) => { const current = state.layers.find((item) => item.id === targetId); if (current?.adjustment) current.adjustment = value; }); write(next); const history = kernel.historyByDocument.get(document.id); if (history) void history.record(mergeableEdit(`Adjustment: ${language === "ru" ? definition.name.ru : definition.name.en}`, () => write(before), () => write(next)), true); }}/></div>; }
    }
  }
  return <div className="dock-panel-body"><p className="panel-hint">{text(language, "Selection-aware properties will appear here.", "Здесь будут отображаться свойства текущего выделения.")}</p><dl><dt>{text(language, "Selection", "Выделение")}</dt><dd>{text(language, "None", "Нет")}</dd><dt>{text(language, "Environment", "Среда")}</dt><dd>{String(params.kind ?? text(language, "Automatic", "Автоматически"))}</dd></dl></div>;
}

function rasterizeTextLayer(layer: RasterLayer, width: number, height: number): void {
  if (!layer.text) return;
  setLayerPixels(layer, renderTextLayerPixels(layer.text, width, height), width, height);
}

/** The glyph that says what kind of layer this is, or nothing for a plain one. */
function layerKindIcon(layer: RasterLayer): string | null {
  if (layer.kind === "text") return "/СЛОЙ-ТЕКСТ.svg";
  if (layer.kind === "adjustment") return layer.adjustment ? rasterAdjustmentById.get(layer.adjustment.kind)?.icon ?? "/КОРРЕКТИРУЮЩИЙ СЛОЙ.svg" : "/КОРРЕКТИРУЮЩИЙ СЛОЙ.svg";
  if (layer.kind === "shape") return "/СЛОЙ-ФИГУРА.svg";
  if (layer.kind === "smart") return "/СЛОЙ-СМАРТ.svg";
  if (layer.kind === "3d") return "/СЛОЙ-3D.svg";
  return null;
}

function LayerThumbnail({ layer, active = false, onActivate }: { layer: RasterLayer; active?: boolean; onActivate?(): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current, context = canvas?.getContext("2d"); if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / layer.width, canvas.height / layer.height);
    const targetWidth = Math.max(1, Math.round(layer.width * scale)), targetHeight = Math.max(1, Math.round(layer.height * scale));
    const left = Math.floor((canvas.width - targetWidth) / 2), top = Math.floor((canvas.height - targetHeight) / 2);
    const thumbnail = context.createImageData(targetWidth, targetHeight);
    for (let y = 0; y < targetHeight; y += 1) for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(layer.width - 1, Math.floor(x / scale)), sourceY = Math.min(layer.height - 1, Math.floor(y / scale));
      const sourceOffset = (sourceY * layer.width + sourceX) * 4, targetOffset = (y * targetWidth + x) * 4;
      thumbnail.data[targetOffset] = layer.pixels[sourceOffset]!; thumbnail.data[targetOffset + 1] = layer.pixels[sourceOffset + 1]!; thumbnail.data[targetOffset + 2] = layer.pixels[sourceOffset + 2]!; thumbnail.data[targetOffset + 3] = layer.pixels[sourceOffset + 3]!;
    }
    context.putImageData(thumbnail, left, top);
  }, [layer.pixels, layer.width, layer.height]);
  if (layer.kind === "group") return <span className="layer-thumb layer-group-thumb"><img src="/ГРУППА.svg" alt=""/></span>;
  return <span className={`layer-thumb${active ? " editing" : ""}`} onClick={(event) => { event.stopPropagation(); onActivate?.(); }}>{layerKindIcon(layer) && <img className="layer-kind-icon" src={layerKindIcon(layer)!} alt="" width={13} height={13}/>}<canvas ref={ref} width="36" height="28" /></span>;
}

function LayerMaskThumbnail({ mask, width, height, active, onActivate }: { mask: RasterLayerMask; width: number; height: number; active: boolean; onActivate(): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current, context = canvas?.getContext("2d"); if (!canvas || !context) return;
    const image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor(x * width / canvas.width)), sourceY = Math.min(height - 1, Math.floor(y * height / canvas.height));
      const value = mask.pixels[sourceY * width + sourceX] ?? 255, offset = (y * canvas.width + x) * 4;
      image.data[offset] = value; image.data[offset + 1] = value; image.data[offset + 2] = value; image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [mask.pixels, width, height]);
  return <span className={`layer-mask-thumb${active ? " editing" : ""}`} title="Edit Layer Mask (Редактировать маску слоя)" onClick={(event) => { event.stopPropagation(); onActivate(); }}><canvas ref={ref} width="28" height="28"/>{mask.linked && <i>⛓</i>}</span>;
}

const layerEffectDefaults: RasterLayer["effects"] = {
  dropShadow: { enabled: false, color: "#000000", opacity: .55, offsetX: 8, offsetY: 8 }, innerShadow: { enabled: false, color: "#000000", opacity: .45, offsetX: 4, offsetY: 4 },
  outerGlow: { enabled: false, color: "#ffffff", opacity: .6, radius: 6 }, innerGlow: { enabled: false, color: "#ffffff", opacity: .5, radius: 5 }, bevel: { enabled: false, strength: .65 }, gradientOverlay: { enabled: false, from: "#8f5cff", to: "#56d8ff", opacity: .7, angle: 0 },
};

/** Schematic Photoshop-style demo icon: a generic square showing what each enabled effect looks like, not the actual layer content. */
function LayerStylePreview({ effects }: { effects: RasterLayer["effects"] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const size = 96, square = 42, left = (size - square) / 2, top = (size - square) / 2;
    context.clearRect(0, 0, size, size);
    const tile = 8;
    for (let y = 0; y < size; y += tile) for (let x = 0; x < size; x += tile) { context.fillStyle = (x / tile + y / tile) % 2 === 0 ? "#bdbdbd" : "#8f8f8f"; context.fillRect(x, y, tile, tile); }

    const outerGlow = effects?.outerGlow, dropShadow = effects?.dropShadow;
    if (outerGlow?.enabled) {
      context.save();
      context.shadowColor = outerGlow.color; context.shadowBlur = Math.max(2, outerGlow.radius) * 1.6; context.globalAlpha = outerGlow.opacity;
      context.fillStyle = "#000"; context.fillRect(left, top, square, square); context.fillRect(left, top, square, square);
      context.restore();
    }
    if (dropShadow?.enabled) {
      context.save();
      context.shadowColor = dropShadow.color; context.shadowBlur = 4; context.shadowOffsetX = dropShadow.offsetX; context.shadowOffsetY = dropShadow.offsetY; context.globalAlpha = dropShadow.opacity;
      context.fillStyle = "#000"; context.fillRect(left, top, square, square);
      context.restore();
    }

    context.save();
    context.beginPath(); context.rect(left, top, square, square); context.clip();
    const gradient = effects?.gradientOverlay;
    if (gradient?.enabled) {
      const radians = gradient.angle * Math.PI / 180, dx = Math.cos(radians) * square / 2, dy = Math.sin(radians) * square / 2, cx = left + square / 2, cy = top + square / 2;
      const linear = context.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
      linear.addColorStop(0, gradient.from); linear.addColorStop(1, gradient.to);
      context.globalAlpha = gradient.opacity; context.fillStyle = linear; context.fillRect(left, top, square, square);
    } else {
      context.fillStyle = "#b9b9b9"; context.fillRect(left, top, square, square);
    }
    context.globalAlpha = 1;

    const bevel = effects?.bevel;
    if (bevel?.enabled) {
      context.strokeStyle = `rgba(255,255,255,${.85 * bevel.strength})`; context.lineWidth = 2;
      context.beginPath(); context.moveTo(left, top + square); context.lineTo(left, top); context.lineTo(left + square, top); context.stroke();
      context.strokeStyle = `rgba(0,0,0,${.85 * bevel.strength})`;
      context.beginPath(); context.moveTo(left + square, top); context.lineTo(left + square, top + square); context.lineTo(left, top + square); context.stroke();
    }
    const innerShadow = effects?.innerShadow;
    if (innerShadow?.enabled) {
      context.save();
      context.shadowColor = innerShadow.color; context.shadowBlur = 5; context.shadowOffsetX = -innerShadow.offsetX; context.shadowOffsetY = -innerShadow.offsetY; context.globalAlpha = innerShadow.opacity;
      context.fillStyle = "#000";
      context.beginPath(); context.rect(left - square, top - square, square * 3, square * 3); context.rect(left, top, square, square); context.fill("evenodd");
      context.restore();
    }
    const innerGlow = effects?.innerGlow;
    if (innerGlow?.enabled) {
      const radius = Math.max(2, Math.min(20, innerGlow.radius));
      context.save();
      context.globalAlpha = innerGlow.opacity; context.strokeStyle = innerGlow.color; context.lineWidth = radius;
      context.strokeRect(left + radius / 2, top + radius / 2, square - radius, square - radius);
      context.restore();
    }
    context.restore();
  }, [effects]);
  return <canvas ref={canvasRef} width={96} height={96} className="style-preview-box"/>;
}

function LayerStyleDialog({ layer, onApply, onClose }: { layer: RasterLayer; onApply(patch: Partial<RasterLayer>): void; onClose(): void }) {
  const [section, setSection] = useState<"blending" | keyof RasterLayer["effects"]>("blending");
  const [draft, setDraft] = useState(() => structuredClone(layer.effects));
  const [blendMode, setBlendMode] = useState(layer.blendMode), [opacity, setOpacity] = useState(layer.opacity), [fillOpacity, setFillOpacity] = useState(layer.fillOpacity ?? 1);
  const items = [["blending", "Blending Options (Параметры смешивания)"], ["bevel", "Bevel & Emboss (Рельеф и тиснение)"], ["innerShadow", "Inner Shadow (Внутренняя тень)"], ["innerGlow", "Inner Glow (Внутреннее свечение)"], ["gradientOverlay", "Gradient Overlay (Наложение градиента)"], ["outerGlow", "Outer Glow (Внешнее свечение)"], ["dropShadow", "Drop Shadow (Тень)"]] as const;
  const effect = section === "blending" ? null : (draft[section] ?? layerEffectDefaults[section]);
  const patchEffect = (patch: Record<string, string | number | boolean>) => { if (section === "blending") return; setDraft((current) => ({ ...current, [section]: { ...(current[section] ?? layerEffectDefaults[section]), ...patch } })); };
  return <div className="dialog-backdrop layer-style-backdrop" onMouseDown={onClose}><section className="layer-style-dialog" role="dialog" aria-modal="true" aria-label="Layer Style (Стиль слоя)" onMouseDown={(event) => event.stopPropagation()}>
    <header><strong>Layer Style (Стиль слоя)</strong><button onClick={onClose}>×</button></header><div className="layer-style-body"><aside>{items.map(([key, label]) => <button className={section === key ? "active" : ""} key={key} onClick={() => setSection(key)}>{key !== "blending" && <input type="checkbox" tabIndex={-1} checked={Boolean(draft[key]?.enabled)} onChange={() => {}}/>}<span>{label}</span></button>)}</aside><main>
      <h3>{items.find(([key]) => key === section)?.[1]}</h3>
      {section === "blending" ? <div className="style-fields"><label>Blend Mode (Режим смешивания)<select value={blendMode} onChange={(event) => setBlendMode(event.target.value as RasterBlendMode)}><option value="normal">Normal (Обычный)</option><option value="multiply">Multiply (Умножение)</option><option value="screen">Screen (Экран)</option><option value="overlay">Overlay (Перекрытие)</option></select></label><label>Opacity (Непрозрачность)<input type="range" min="0" max="100" value={opacity * 100} onChange={(event) => setOpacity(event.target.valueAsNumber / 100)}/><output>{Math.round(opacity * 100)}%</output></label><label>Fill (Заливка)<input type="range" min="0" max="100" value={fillOpacity * 100} onChange={(event) => setFillOpacity(event.target.valueAsNumber / 100)}/><output>{Math.round(fillOpacity * 100)}%</output></label><div className="channel-toggles">Channels (Каналы): <label><input type="checkbox" defaultChecked/>R</label><label><input type="checkbox" defaultChecked/>G</label><label><input type="checkbox" defaultChecked/>B</label></div><div className="blend-if"><strong>Blend If: Gray (Смешивание, если: Серый)</strong><span className="blend-gradient"/><small>This Layer (Текущий слой)　0　　　　　　　　　255</small><span className="blend-gradient"/><small>Underlying Layer (Фон)　0　　　　　　　　255</small></div></div> : effect && <div className="style-fields"><label className="effect-enable"><input type="checkbox" checked={effect.enabled} onChange={(event) => patchEffect({ enabled: event.target.checked })}/>Enable (Включить)</label>{"color" in effect && <label>Color (Цвет)<input type="color" value={effect.color} onChange={(event) => patchEffect({ color: event.target.value })}/></label>}{"opacity" in effect && <label>Opacity (Непрозрачность)<input type="range" min="0" max="100" value={effect.opacity * 100} onChange={(event) => patchEffect({ opacity: event.target.valueAsNumber / 100 })}/><output>{Math.round(effect.opacity * 100)}%</output></label>}{"radius" in effect && <label>Size (Размер)<input type="range" min="1" max="32" value={effect.radius} onChange={(event) => patchEffect({ radius: event.target.valueAsNumber })}/><output>{effect.radius}px</output></label>}{"offsetX" in effect && <><label>Distance X (Смещение X)<input type="range" min="-50" max="50" value={effect.offsetX} onChange={(event) => patchEffect({ offsetX: event.target.valueAsNumber })}/><output>{effect.offsetX}px</output></label><label>Distance Y (Смещение Y)<input type="range" min="-50" max="50" value={effect.offsetY} onChange={(event) => patchEffect({ offsetY: event.target.valueAsNumber })}/><output>{effect.offsetY}px</output></label></>}{"strength" in effect && <label>Depth (Глубина)<input type="range" min="0" max="200" value={effect.strength * 100} onChange={(event) => patchEffect({ strength: event.target.valueAsNumber / 100 })}/><output>{Math.round(effect.strength * 100)}%</output></label>}{"from" in effect && <><label>From (Начало)<input type="color" value={effect.from} onChange={(event) => patchEffect({ from: event.target.value })}/></label><label>To (Конец)<input type="color" value={effect.to} onChange={(event) => patchEffect({ to: event.target.value })}/></label><label>Angle (Угол)<input type="range" min="-180" max="180" value={effect.angle} onChange={(event) => patchEffect({ angle: event.target.valueAsNumber })}/><output>{effect.angle}°</output></label></>}</div>}
    </main><aside className="style-preview"><LayerStylePreview effects={draft}/><small>Preview (Предпросмотр)</small></aside></div><footer><button onClick={onClose}>Cancel (Отмена)</button><button className="primary" onClick={() => { onApply({ effects: draft, blendMode, opacity, fillOpacity }); onClose(); }}>OK</button></footer>
  </section></div>;
}

function LayersPanel() {
  const documents = useDocuments();
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const language = useShellStore((state) => state.language);
  const [styleLayerId, setStyleLayerId] = useState<string | null>(null);
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const [layerFilter, setLayerFilter] = useState<"all" | "pixel" | "adjustment" | "text" | "shape" | "smart">("all");
  const [layerFilterOn, setLayerFilterOn] = useState(false);
  const [dropHint, setDropHint] = useState<{ overId: string; position: "above" | "into" | "below" } | null>(null);
  // The drop handler runs from a window listener, outside this render's closure.
  const dropHintRef = useRef(dropHint);
  dropHintRef.current = dropHint;
  const selectedLayerIds = useShellStore((state) => (activeDocumentId ? state.selectedLayerIdsByDocument[activeDocumentId] : undefined) ?? EMPTY_LAYER_SELECTION);
  const setSelectedLayers = useShellStore((state) => state.setSelectedLayers);
  const editingMaskLayerId = useShellStore((state) => activeDocumentId ? state.editingMaskLayerIdByDocument[activeDocumentId] ?? null : null);
  const setEditingMask = useShellStore((state) => state.setEditingMask);
  useEffect(() => {
    const open = () => { const current = activeDocumentId ? kernel.documents.get<RasterDocumentState>(activeDocumentId) : null; if (current && isRasterDocumentState(current.state)) setStyleLayerId(current.state.activeLayerId); };
    window.addEventListener("vravio-layer-style-open", open); return () => window.removeEventListener("vravio-layer-style-open", open);
  }, [activeDocumentId]);
  const active = documents.find((document) => document.id === activeDocumentId);
  const timed = active?.kind === "audio" || active?.kind === "video";
  if (active && isRasterDocumentState(active.state)) {
    const state = active.state;
    const addLayer = () => { let createdId = ""; void changeRasterDocument(active.id, "New Layer (Новый слой)", (current) => { const selected = current.layers.find((item) => item.id === current.activeLayerId); const parentId = selected?.kind === "group" ? selected.id : (selected?.parentId ?? null); const layer = createRasterLayer(current.width, current.height, `Layer ${current.layers.length + 1} (Слой ${current.layers.length + 1})`); appendLayer(current, layer, parentId); current.activeLayerId = layer.id; createdId = layer.id; return true; }); setSelectedLayers(active.id, [createdId]); };
    const addGroup = () => { let createdId = ""; void changeRasterDocument(active.id, "New Group (Новая группа)", (current) => { const number = current.layers.filter((item) => item.kind === "group").length + 1; const group = appendRasterGroup(current, `Group ${number} (Группа ${number})`); current.activeLayerId = group.id; createdId = group.id; return true; }); setSelectedLayers(active.id, [createdId]); };
    const addAdjustment = (definition: (typeof rasterAdjustments)[number]) => { void changeRasterDocument(active.id, `New Adjustment Layer: ${definition.name.en} (Новый корректирующий слой: ${definition.name.ru})`, (current) => { const selected = current.layers.find((item) => item.id === current.activeLayerId); const layer = createAdjustmentLayer(current.width, current.height, definition.id, `${definition.name.en} (${definition.name.ru})`); appendLayer(current, layer, selected?.kind === "group" ? selected.id : (selected?.parentId ?? null)); current.activeLayerId = layer.id; return true; }); setShowAdjustments(false); };
    const deleteLayer = () => { let survivorId = "", removedMaskTarget = false; void changeRasterDocument(active.id, "Delete Layer (Удалить слой)", (current) => { const index = current.layers.findIndex((item) => item.id === current.activeLayerId); if (index < 0) return false; const target = current.layers[index]!; const removed = new Set([target.id, ...rasterLayerDescendantIds(current.layers, target.id)]); removedMaskTarget = editingMaskLayerId ? removed.has(editingMaskLayerId) : false; current.layers = current.layers.filter((item) => !removed.has(item.id)); if (!current.layers.some((item) => item.kind !== "group")) appendLayer(current, createRasterLayer(current.width, current.height, "Layer 1 (Слой 1)")); const next = current.layers[Math.min(index, current.layers.length - 1)] ?? current.layers[0]; if (!next) return false; current.activeLayerId = next.id; survivorId = next.id; return true; }); if (removedMaskTarget) setEditingMask(active.id, null); if (survivorId) setSelectedLayers(active.id, [survivorId]); };
    const selectLayer = (id: string) => kernel.documents.update<RasterDocumentState>(active.id, (current) => { current.activeLayerId = id; });
    const clickLayer = (id: string, event: React.MouseEvent) => {
      selectLayer(id);
      if (event.shiftKey && selectedLayerIds.length) {
        const order = state.layers.map((item) => item.id);
        const anchor = selectedLayerIds[selectedLayerIds.length - 1] ?? state.activeLayerId;
        const from = order.indexOf(anchor), to = order.indexOf(id);
        if (from >= 0 && to >= 0) { const [start, end] = from < to ? [from, to] : [to, from]; setSelectedLayers(active.id, order.slice(start, end + 1)); return; }
      }
      if (event.metaKey || event.ctrlKey) { setSelectedLayers(active.id, selectedLayerIds.includes(id) ? selectedLayerIds.filter((item) => item !== id) : [...selectedLayerIds, id]); return; }
      setSelectedLayers(active.id, [id]);
    };
    const toggleVisible = (id: string) => kernel.documents.update<RasterDocumentState>(active.id, (current) => { const layer = current.layers.find((item) => item.id === id); if (layer) layer.visible = !layer.visible; });
    const toggleExpanded = (id: string) => kernel.documents.update<RasterDocumentState>(active.id, (current) => { const layer = current.layers.find((item) => item.id === id); if (layer?.kind === "group") layer.expanded = layer.expanded === false; });
    const addMask = () => { let targetId: string | null = null; void changeRasterDocument(active.id, "Add Layer Mask (Добавить маску слоя)", (current) => { const layer = current.layers.find((item) => item.id === current.activeLayerId); if (layer && layer.kind !== "group" && !layer.mask) { layer.mask = createRasterLayerMask(current.width, current.height); targetId = layer.id; return true; } return false; }); if (targetId) setEditingMask(active.id, targetId); };
    const toggleClipping = () => void changeRasterDocument(active.id, "Toggle Clipping Mask (Обтравочная маска)", (current) => { const layer = current.layers.find((item) => item.id === current.activeLayerId); if (layer && layer.kind !== "group") { layer.clipping = !layer.clipping; return true; } return false; });
    /**
     * Dragging a row.
     *
     * Held in a ref rather than state: the pointer moves at the refresh rate,
     * and only the insertion line has to re-render as it goes.
     */
    const beginRowDrag = (layerId: string) => (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const list = event.currentTarget.closest(".layer-list");
      if (!list) return;
      const startY = event.clientY;
      let dragging = false;

      const rowUnder = (clientY: number) => {
        for (const element of list.querySelectorAll<HTMLElement>(".layer-row")) {
          const box = element.getBoundingClientRect();
          if (clientY >= box.top && clientY <= box.bottom) return { element, box };
        }
        return null;
      };
      const overTrash = (clientX: number, clientY: number) => {
        const trash = window.document.querySelector<HTMLElement>(".layer-actions [data-role=\"trash\"]");
        if (!trash) return false;
        const box = trash.getBoundingClientRect();
        return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
      };

      const move = (native: PointerEvent) => {
        // A few pixels of slop, so a click that wobbles is still a click.
        if (!dragging && Math.abs(native.clientY - startY) < 4) return;
        dragging = true;
        setDraggingLayerId(layerId);
        if (overTrash(native.clientX, native.clientY)) { setDropHint({ overId: "trash", position: "into" }); return; }
        const under = rowUnder(native.clientY);
        if (!under?.element.dataset.layerId) { setDropHint(null); return; }
        const overId = under.element.dataset.layerId;
        const isGroup = under.element.dataset.group === "true";
        setDropHint({ overId, position: dropPositionInRow(native.clientY - under.box.top, under.box.height, isGroup) });
      };

      const finish = (native: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        const hint = dropHintRef.current;
        setDraggingLayerId(null);
        setDropHint(null);
        if (!dragging || !hint) return;
        if (hint.overId === "trash") { selectLayer(layerId); deleteLayer(); return; }
        if (hint.overId === layerId) return;
        void native;
        kernel.documents.update<RasterDocumentState>(active.id, (current) => {
          const target = dropTargetForRow(current, hint.overId, hint.position);
          if (target) placeLayer(current, layerId, target.parentId, target.index);
        });
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    };

    const activeLayer = state.layers.find((layer) => layer.id === state.activeLayerId) ?? state.layers[0];
    if (!activeLayer) return <div className="dock-panel-body"><div className="empty-row">{text(language, "No layers", "Нет слоёв")}</div></div>;
    const updateActive = (patch: Partial<RasterLayer>) => kernel.documents.update<RasterDocumentState>(active.id, (current) => { const layer = current.layers.find((item) => item.id === current.activeLayerId); if (layer) Object.assign(layer, patch); });
    const blendModes: RasterBlendMode[] = ["normal", "dissolve", "darken", "multiply", "colorBurn", "linearBurn", "darkerColor", "lighten", "screen", "colorDodge", "linearDodge", "lighterColor", "overlay", "softLight", "hardLight", "vividLight", "linearLight", "pinLight", "hardMix", "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity"];
    const styleLayer = state.layers.find((layer) => layer.id === styleLayerId);
    return <div className="dock-panel-body layers-panel">
      <div className="layer-filter">
        <select value={layerFilter} onChange={(event) => setLayerFilter(event.target.value as typeof layerFilter)} aria-label={text(language, "Filter layers", "Фильтр слоёв")}>
          <option value="all">{text(language, "Kind", "Вид")}</option>
          <option value="pixel">{text(language, "Pixel", "Пиксельные")}</option>
          <option value="adjustment">{text(language, "Adjustment", "Корректирующие")}</option>
          <option value="text">{text(language, "Type", "Текстовые")}</option>
          <option value="shape">{text(language, "Shape", "Фигуры")}</option>
          <option value="smart">{text(language, "Smart", "Смарт-объекты")}</option>
        </select>
        {/* Photoshop keeps the filter switchable without losing what was chosen,
            so a filtered view can be turned off and back on. */}
        <button className={layerFilterOn ? "active" : ""} aria-pressed={layerFilterOn} title={text(language, "Turn filtering on or off", "Включить или выключить фильтрацию")}
          onClick={() => setLayerFilterOn((value) => !value)}>{layerFilterOn ? "◉" : "◎"}</button>
      </div>
      <div className="layer-locks">
        <span>{text(language, "Lock:", "Закрепить:")}</span>
        {([
          ["lockTransparent", "/ПРОЗРАЧНОСТЬ.svg", text(language, "Lock transparent pixels", "Закрепить прозрачные пиксели")],
          ["lockPixels", "/КИСТЬ_1.svg", text(language, "Lock image pixels", "Закрепить пиксели изображения")],
          ["lockPosition", "/КУРСОР.svg", text(language, "Lock position", "Закрепить положение")],
          ["locked", "/ЗАМОК.svg", text(language, "Lock all", "Закрепить все")],
        ] as const).map(([key, icon, title]) => (
          <button key={key} className={activeLayer[key] ? "active" : ""} title={title} aria-pressed={Boolean(activeLayer[key])}
            onClick={() => updateActive({ [key]: !activeLayer[key] } as Partial<RasterLayer>)}><img src={icon} alt=""/></button>
        ))}
      </div>
      <div className="layer-controls"><select value={activeLayer.blendMode} onChange={(event) => updateActive({ blendMode: event.target.value as RasterBlendMode })}>{blendModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select><div className="layer-controls-row"><label><span>{text(language, "Opacity", "Непрозр.")}</span><input type="number" min="0" max="100" value={Math.round(activeLayer.opacity * 100)} onChange={(event) => updateActive({ opacity: Math.max(0, Math.min(1, event.target.valueAsNumber / 100)) })}/><i>%</i></label><label><span>{text(language, "Fill", "Заливка")}</span><input type="number" min="0" max="100" value={Math.round((activeLayer.fillOpacity ?? 1) * 100)} onChange={(event) => updateActive({ fillOpacity: Math.max(0, Math.min(1, event.target.valueAsNumber / 100)) })}/><i>%</i></label></div></div>
      <div className="layer-list">{rasterLayerRows(state.layers).filter(({ layer }) => !layerFilterOn || layerFilter === "all" || layer.kind === layerFilter || layer.kind === "group").map(({ layer, depth }) => <div className={[layer.id === state.activeLayerId ? "active" : "", selectedLayerIds.includes(layer.id) ? "selected" : "", layer.kind === "group" ? "group" : "", draggingLayerId === layer.id ? "dragging" : "", "layer-row"].filter(Boolean).join(" ")} style={{ "--layer-depth": depth } as CSSProperties} key={layer.id} data-layer-id={layer.id} data-group={layer.kind === "group"} data-drop={dropHint?.overId === layer.id ? dropHint.position : undefined} onPointerDown={beginRowDrag(layer.id)}><button onClick={() => toggleVisible(layer.id)} aria-label={text(language, "Toggle visibility", "Переключить видимость")}><img src={layer.visible ? "/ГЛАЗ ОТКРЫТ.svg" : "/ГЛАЗ ЗАКРЫТ.svg"} alt=""/></button><button onClick={(event) => clickLayer(layer.id, event)} onDoubleClick={() => { selectLayer(layer.id); if (layer.kind !== "group") setStyleLayerId(layer.id); }}><span className="layer-hierarchy-space"/>{layer.kind === "group" && <span className="layer-disclosure" onClick={(event) => { event.stopPropagation(); toggleExpanded(layer.id); }}>{layer.expanded === false ? "▸" : "▾"}</span>}<LayerThumbnail layer={layer} active={layer.id === state.activeLayerId && editingMaskLayerId !== layer.id} onActivate={() => { selectLayer(layer.id); setEditingMask(active.id, null); setSelectedLayers(active.id, [layer.id]); }}/>{layer.mask && <LayerMaskThumbnail mask={layer.mask} width={state.width} height={state.height} active={editingMaskLayerId === layer.id} onActivate={() => { selectLayer(layer.id); setEditingMask(active.id, layer.id); setSelectedLayers(active.id, [layer.id]); }}/>}{layer.colorLabel && layer.colorLabel !== "none" && <i className="layer-color-label" data-color={layer.colorLabel} aria-hidden="true"/>}<span className="layer-row-text"><b>{localized(layer.name, language)}</b><small>{layer.kind === "group" ? (layer.groupMode === "isolated" ? "isolated" : "pass through") : `${layer.blendMode} · ${Math.round(layer.opacity * 100)}%`}</small></span>{layer.linkGroup && <em className="layer-badge" title={text(language, "Linked", "Связан")}>⛓</em>}{(layer.locked || layer.lockPixels || layer.lockPosition || layer.lockTransparent) && <em className="layer-badge" title={text(language, "Locked", "Закреплён")}>🔒</em>}</button></div>)}</div>
      <div className="layer-actions adjustment-actions">{showAdjustments && <div className="adjustment-menu">{rasterAdjustments.filter((definition) => definition.supportsAdjustmentLayer).map((definition) => <button key={definition.id} onClick={() => addAdjustment(definition)}><img src={definition.icon} alt="" width={16} height={16}/><span>{language === "ru" ? definition.name.ru : definition.name.en}</span></button>)}</div>}<button onClick={() => { kernel.documents.update<RasterDocumentState>(active.id, (current) => { toggleLayerLink(current, selectedLayerIds.length > 1 ? selectedLayerIds : [current.activeLayerId]); }); }} title={text(language, "Link layers", "Связать слои")}><img src="/СВЯЗЬ.svg" alt=""/></button><button disabled={activeLayer.kind === "group"} onClick={() => setStyleLayerId(activeLayer.id)} title={text(language, "Layer style", "Стиль слоя")}><b className="fx-label">fx</b></button><button onClick={() => setShowAdjustments((value) => !value)} title={text(language, "New adjustment layer", "Новый корректирующий слой")}><img src="/КОРРЕКТИРУЮЩИЙ СЛОЙ.svg" alt=""/></button><button className={activeLayer.clipping ? "active" : ""} onClick={toggleClipping} disabled={activeLayer.kind === "group"} title={text(language, "Create clipping mask", "Создать обтравочную маску")}><img src="/ОБТРАВОЧНАЯ МАСКА.svg" alt=""/></button><button onClick={addMask} disabled={activeLayer.kind === "group" || Boolean(activeLayer.mask)} title={text(language, "Add layer mask", "Добавить маску слоя")}><img src="/МАСКА СЛОЯ.svg" alt=""/></button><button onClick={addGroup} title={text(language, "New group", "Новая группа")}><img src="/ГРУППА.svg" alt=""/></button><button onClick={addLayer} title={text(language, "New layer", "Новый слой")}><img src="/НОВЫЙ СЛОЙ.svg" alt=""/></button><button data-role="trash" data-armed={dropHint?.overId === "trash" || undefined} onClick={deleteLayer} title={text(language, "Delete layer (drop a layer here)", "Удалить слой (можно перетащить сюда)")}><img src="/КОРЗИНА.svg" alt=""/></button></div>
      {styleLayer && <LayerStyleDialog layer={styleLayer} onClose={() => setStyleLayerId(null)} onApply={(patch) => kernel.documents.update<RasterDocumentState>(active.id, (current) => { const target = current.layers.find((layer) => layer.id === styleLayer.id); if (target) Object.assign(target, patch); })}/>} 
    </div>;
  }
  return <div className="dock-panel-body"><button className="panel-action">＋ {timed ? text(language, "Track", "Дорожка") : text(language, "Layer", "Слой")}</button><div className="empty-row">{timed ? text(language, "No tracks yet", "Дорожек пока нет") : text(language, "No layers yet", "Слоёв пока нет")}</div></div>;
}

function HistoryPanel() {
  const language = useShellStore((state) => state.language);
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const history = activeDocumentId ? kernel.historyByDocument.get(activeDocumentId) : undefined;
  const [, bump] = useState(0);

  // The HistoryManager lives outside React, so the panel re-reads its timeline whenever
  // a step is executed, undone or redone.
  useEffect(() => {
    if (!history) return;
    const subscription = history.subscribe(() => bump((value) => value + 1));
    return () => subscription.dispose();
  }, [history]);

  if (!activeDocumentId || !history) return <div className="dock-panel-body"><div className="empty-row">{text(language, "No document", "Нет документа")}</div></div>;

  const timeline = history.timeline();
  const jump = (position: number) => { void history.jumpTo(position); };

  return <div className="dock-panel-body history-panel">
    <div className="history-list">
      <button className={`history-entry${history.position === 0 ? " active" : ""}`} onClick={() => jump(0)}>
        <i className="history-bullet" aria-hidden="true" />
        <span>{text(language, "Open document", "Открыть документ")}</span>
      </button>
      {timeline.map((entry) => <button
        key={`${entry.position}-${entry.timestamp}`}
        className={`history-entry${entry.position === history.position ? " active" : ""}${entry.applied ? "" : " undone"}`}
        onClick={() => jump(entry.position)}
        title={new Date(entry.timestamp).toLocaleTimeString()}
      >
        <i className="history-bullet" aria-hidden="true" />
        <span>{localized(entry.label, language)}</span>
      </button>)}
    </div>
    <footer className="history-footer">
      <span>{history.position} / {timeline.length}</span>
      {history.memoryBytes > 0 && <span>{(history.memoryBytes / (1024 * 1024)).toFixed(1)} MB</span>}
    </footer>
  </div>;
}

function AssetsPanel() {
  const language = useShellStore((state) => state.language);
  return <div className="dock-panel-body"><button className="panel-action">＋ {text(language, "Import asset", "Импортировать ассет")}</button><div className="empty-row">{text(language, "Project assets will be content-addressed", "Ассеты проекта будут храниться с адресацией по содержимому")}</div></div>;
}

function EffectsPanel() {
  const language = useShellStore((state) => state.language);
  return <div className="dock-panel-body"><div className="empty-row">{text(language, "Open Layer Style by double-clicking a layer row.", "Откройте «Стиль слоя» двойным щелчком по строке слоя.")}</div></div>;
}

const components = {
  viewport: ViewportPanel,
  inspector: InspectorPanel,
  layers: LayersPanel,
  history: HistoryPanel,
  assets: AssetsPanel,
  effects: EffectsPanel,
  color: ColorPanel,
  navigator: NavigatorPanel,
};

/**
 * A glyph per panel, drawn for the purpose.
 *
 * These were borrowed from tools — the colour panel wore the eyedropper, the
 * navigator wore the zoom loupe — which read as "the tool" rather than "the
 * panel" and left two places in the interface showing the same picture for
 * different things. They are used as CSS masks, so the colour comes from the
 * theme and not from the file.
 */
const panelIcons: Record<string, string> = Object.fromEntries(rasterCorePanels.map((panel) => [panel.id, panel.icon]));
panelIcons.viewport = "/РАДИО.svg";
function PanelTab({ api }: IDockviewPanelHeaderProps) {
  return <div className="panel-tab" title={api.title}><i aria-hidden="true" style={{ "--panel-mask": `url("${panelIcons[api.id] ?? "/ПАРАМЕТРЫ.svg"}")` } as CSSProperties}/><span>{api.title}</span></div>;
}

function PanelHeaderActions({ api }: IDockviewHeaderActionsProps) {
  return <button className="panel-collapse" onClick={() => api.isCollapsed() ? api.expand() : api.collapse()} title={api.isCollapsed() ? "Expand panels (Развернуть панели)" : "Collapse to icons (Свернуть в значки)"} aria-label={api.isCollapsed() ? "Expand panels" : "Collapse panels"}>{api.isCollapsed() ? "»" : "«"}</button>;
}

function createDefaultLayout(event: DockviewReadyEvent, language: Language): void {
  const viewportGroup = event.api.addGroup({ direction: "left", hideHeader: true });
  event.api.addPanel({ id: "viewport", component: "viewport", title: text(language, "Canvas", "Холст"), position: { referenceGroup: viewportGroup, direction: "within" } });
  const sideGroup = event.api.addEdgeGroup("right", { id: "right-panels", initialSize: 280, minimumSize: 220, collapsedSize: 43, autoHide: true });
  sideGroup.setHeaderPosition("top");
  const visible = readVisiblePanelIds();
  for (const panel of rasterCorePanels) if (visible.has(panel.id)) event.api.addPanel({ id: panel.id, component: panel.component, title: corePanelTitle(panel, language), position: { referenceGroup: sideGroup.id, direction: "within" } });
}

export function DockLayout() {
  const language = useShellStore((state) => state.language);
  const apiRef = useRef<DockviewReadyEvent["api"] | null>(null);
  useEffect(() => {
    const handle = (raw: Event) => {
      const event = raw as CustomEvent<{ id: string; visible: boolean }>;
      const api = apiRef.current, definition = rasterCorePanelById.get(event.detail.id); if (!api || !definition) return;
      const existing = api.getPanel(definition.id);
      if (!event.detail.visible && existing) { api.removePanel(existing); return; }
      if (event.detail.visible && !existing) {
        let groupId = api.getGroup("right-panels")?.id;
        if (!groupId) { const group = api.addEdgeGroup("right", { id: "right-panels", initialSize: 280, minimumSize: 220, collapsedSize: 43, autoHide: true }); group.setHeaderPosition("top"); groupId = group.id; }
        api.addPanel({ id: definition.id, component: definition.component, title: corePanelTitle(definition, language), position: { referenceGroup: groupId, direction: "within" } });
      }
    };
    window.addEventListener(PANEL_REQUEST_EVENT, handle);
    return () => window.removeEventListener(PANEL_REQUEST_EVENT, handle);
  }, [language]);
  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    const storageKey = `${LAYOUT_STORAGE_KEY}.${language}`;
    const serialized = localStorage.getItem(storageKey);
    let restored = false;
    if (serialized) {
      try {
        event.api.fromJSON(JSON.parse(serialized) as SerializedDockview);
        restored = true;
      } catch {
        localStorage.removeItem(storageKey);
      }
    }
    if (!restored) createDefaultLayout(event, language);
    event.api.onDidLayoutChange(() => { localStorage.setItem(storageKey, JSON.stringify(event.api.toJSON())); persistVisiblePanelIds(event.api.panels.map((panel) => panel.id).filter((id) => rasterCorePanelById.has(id))); });
  }, [language]);

  return <div className="dock-host"><DockviewReact key={language} theme={themeDark} components={components} defaultTabComponent={PanelTab} rightHeaderActionsComponent={PanelHeaderActions} onReady={onReady} /></div>;
}
