import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { DockviewReact, themeDark, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from "dockview-react";
import type { DockviewReadyEvent, SerializedDockview } from "dockview";
import { environmentMeta } from "./environment";
import { useShellStore } from "./store";
import { useDocuments } from "./useDocuments";
import { RasterWorkspace } from "./RasterWorkspace";
import { createAdjustmentLayer, createRasterLayer, isRasterDocumentState, type RasterAdjustment, type RasterBlendMode, type RasterDocumentState, type RasterLayer } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { localized, text } from "./i18n";
import { renderTextLayerPixels } from "./textRender";
import type { Language } from "./store";
import "dockview-react/dist/styles/dockview.css";

const LAYOUT_STORAGE_KEY = "vravio.workspace.default.v4";
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
      return <div className="dock-panel-body property-stack"><strong>Type Properties (Свойства текста)</strong><label>Text (Текст)<textarea value={layer.text.value} onChange={(event) => updateText({ value: event.target.value })} /></label><label>Font (Шрифт)<input value={layer.text.fontFamily} onChange={(event) => updateText({ fontFamily: event.target.value })} /></label><label>Size (Кегль)<input type="number" min="1" max="1000" value={layer.text.fontSize} onChange={(event) => updateText({ fontSize: event.target.valueAsNumber })} /></label><label>Leading (Межстрочный)<input type="number" min="0.5" max="5" step="0.05" value={layer.text.lineHeight} onChange={(event) => updateText({ lineHeight: event.target.valueAsNumber })} /></label><label>Tracking (Межбуквенный)<input type="number" min="-50" max="200" value={layer.text.letterSpacing} onChange={(event) => updateText({ letterSpacing: event.target.valueAsNumber })} /></label><label>Align (Выравнивание)<select value={layer.text.align} onChange={(event) => updateText({ align: event.target.value as "left" | "center" | "right" })}><option value="left">Left (Слева)</option><option value="center">Center (По центру)</option><option value="right">Right (Справа)</option></select></label><label>Color (Цвет)<input type="color" value={layer.text.color} onChange={(event) => updateText({ color: event.target.value })} /></label><div className="text-style-toggles"><button className={layer.text.bold ? "active" : ""} onClick={() => updateText({ bold: !layer.text?.bold })} title="Bold (Полужирный)"><b>B</b></button><button className={layer.text.italic ? "active" : ""} onClick={() => updateText({ italic: !layer.text?.italic })} title="Italic (Курсив)"><i>I</i></button><button className={layer.text.underline ? "active" : ""} onClick={() => updateText({ underline: !layer.text?.underline })} title="Underline (Подчёркнутый)"><u>U</u></button></div></div>;
    }
    if (layer?.kind === "adjustment" && layer.adjustment) {
      const adjustment = layer.adjustment;
      const patchAdjustment = (patch: Partial<RasterAdjustment>) => kernel.documents.update<RasterDocumentState>(document.id, (state) => { const current = state.layers.find((item) => item.id === state.activeLayerId); if (current?.adjustment) current.adjustment = { ...current.adjustment, ...patch } as RasterAdjustment; });
      const slider = (label: string, key: string, value: number, min: number, max: number, step = 1) => <label>{label}<input type="range" min={min} max={max} step={step} value={value} onChange={(event) => patchAdjustment({ [key]: event.target.valueAsNumber } as Partial<RasterAdjustment>)}/><output>{value}</output></label>;
      return <div className="dock-panel-body property-stack"><strong>Adjustment (Коррекция): {adjustment.kind}</strong>{adjustment.kind === "levels" && <>{slider("Input black (Чёрная точка)", "blackInput", adjustment.blackInput, 0, 254)}{slider("Gamma (Гамма)", "gamma", adjustment.gamma, .1, 10, .01)}{slider("Input white (Белая точка)", "whiteInput", adjustment.whiteInput, 1, 255)}</>}{adjustment.kind === "brightnessContrast" && <>{slider("Brightness (Яркость)", "brightness", adjustment.brightness, -100, 100)}{slider("Contrast (Контраст)", "contrast", adjustment.contrast, -100, 100)}</>}{adjustment.kind === "hueSaturation" && <>{slider("Hue (Цветовой тон)", "hue", adjustment.hue, -180, 180)}{slider("Saturation (Насыщенность)", "saturation", adjustment.saturation, -100, 100)}{slider("Lightness (Светлота)", "lightness", adjustment.lightness, -100, 100)}</>}{adjustment.kind === "colorBalance" && <>{slider("Cyan / Red (Голубой / Красный)", "cyanRed", adjustment.cyanRed, -100, 100)}{slider("Magenta / Green (Пурпурный / Зелёный)", "magentaGreen", adjustment.magentaGreen, -100, 100)}{slider("Yellow / Blue (Жёлтый / Синий)", "yellowBlue", adjustment.yellowBlue, -100, 100)}</>}{adjustment.kind === "posterize" && slider("Levels (Уровни)", "levels", adjustment.levels, 2, 255)}{adjustment.kind === "threshold" && slider("Threshold (Порог)", "threshold", adjustment.threshold, 0, 255)}{adjustment.kind === "curves" && <p className="panel-hint">Curve points are stored non-destructively (Опорные точки хранятся неразрушающе).</p>}{adjustment.kind === "invert" && <p className="panel-hint">No parameters (Нет параметров).</p>}</div>;
    }
  }
  return <div className="dock-panel-body"><p className="panel-hint">{text(language, "Selection-aware properties will appear here.", "Здесь будут отображаться свойства текущего выделения.")}</p><dl><dt>{text(language, "Selection", "Выделение")}</dt><dd>{text(language, "None", "Нет")}</dd><dt>{text(language, "Environment", "Среда")}</dt><dd>{String(params.kind ?? text(language, "Automatic", "Автоматически"))}</dd></dl></div>;
}

function rasterizeTextLayer(layer: RasterLayer, width: number, height: number): void {
  if (!layer.text) return;
  layer.pixels = renderTextLayerPixels(layer.text, width, height);
}

function LayerThumbnail({ layer }: { layer: RasterLayer }) {
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
  return <span className="layer-thumb">{layer.kind === "text" && <b>T</b>}{layer.kind === "adjustment" && <b>◐</b>}<canvas ref={ref} width="36" height="28" /></span>;
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
  const selectedLayerIds = useShellStore((state) => (activeDocumentId ? state.selectedLayerIdsByDocument[activeDocumentId] : undefined) ?? EMPTY_LAYER_SELECTION);
  const setSelectedLayers = useShellStore((state) => state.setSelectedLayers);
  useEffect(() => {
    const open = () => { const current = activeDocumentId ? kernel.documents.get<RasterDocumentState>(activeDocumentId) : null; if (current && isRasterDocumentState(current.state)) setStyleLayerId(current.state.activeLayerId); };
    window.addEventListener("vravio-layer-style-open", open); return () => window.removeEventListener("vravio-layer-style-open", open);
  }, [activeDocumentId]);
  const active = documents.find((document) => document.id === activeDocumentId);
  const timed = active?.kind === "audio" || active?.kind === "video";
  if (active && isRasterDocumentState(active.state)) {
    const state = active.state;
    const addLayer = () => { let createdId = ""; kernel.documents.update<RasterDocumentState>(active.id, (current) => { const layer = createRasterLayer(current.width, current.height, `Layer ${current.layers.length + 1} (Слой ${current.layers.length + 1})`); current.layers.push(layer); current.activeLayerId = layer.id; createdId = layer.id; }); setSelectedLayers(active.id, [createdId]); };
    const adjustmentLabels: Array<[RasterAdjustment["kind"], string]> = [["brightnessContrast", "Brightness/Contrast (Яркость/Контраст)"], ["levels", "Levels (Уровни)"], ["curves", "Curves (Кривые)"], ["hueSaturation", "Hue/Saturation (Тон/Насыщенность)"], ["colorBalance", "Color Balance (Цветовой баланс)"], ["invert", "Invert (Инверсия)"], ["posterize", "Posterize (Постеризация)"], ["threshold", "Threshold (Порог)"]];
    const addAdjustment = (kind: RasterAdjustment["kind"], name: string) => { kernel.documents.update<RasterDocumentState>(active.id, (current) => { const layer = createAdjustmentLayer(current.width, current.height, kind, name); current.layers.push(layer); current.activeLayerId = layer.id; }); setShowAdjustments(false); };
    const deleteLayer = () => { let survivorId = ""; kernel.documents.update<RasterDocumentState>(active.id, (current) => { const index = current.layers.findIndex((item) => item.id === current.activeLayerId); if (index < 0) return; current.layers.splice(index, 1); if (!current.layers.length) current.layers.push(createRasterLayer(current.width, current.height, "Layer 1 (Слой 1)")); current.activeLayerId = current.layers[Math.min(index, current.layers.length - 1)]!.id; survivorId = current.activeLayerId; }); if (survivorId) setSelectedLayers(active.id, [survivorId]); };
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
    const activeLayer = state.layers.find((layer) => layer.id === state.activeLayerId) ?? state.layers[0];
    if (!activeLayer) return <div className="dock-panel-body"><div className="empty-row">{text(language, "No layers", "Нет слоёв")}</div></div>;
    const updateActive = (patch: Partial<RasterLayer>) => kernel.documents.update<RasterDocumentState>(active.id, (current) => { const layer = current.layers.find((item) => item.id === current.activeLayerId); if (layer) Object.assign(layer, patch); });
    const blendModes: RasterBlendMode[] = ["normal", "dissolve", "darken", "multiply", "colorBurn", "linearBurn", "darkerColor", "lighten", "screen", "colorDodge", "linearDodge", "lighterColor", "overlay", "softLight", "hardLight", "vividLight", "linearLight", "pinLight", "hardMix", "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity"];
    const styleLayer = state.layers.find((layer) => layer.id === styleLayerId);
    return <div className="dock-panel-body layers-panel">
      <div className="layer-controls"><select value={activeLayer.blendMode} onChange={(event) => updateActive({ blendMode: event.target.value as RasterBlendMode })}>{blendModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select><div className="layer-controls-row"><label><span>{text(language, "Opacity", "Непрозр.")}</span><input type="number" min="0" max="100" value={Math.round(activeLayer.opacity * 100)} onChange={(event) => updateActive({ opacity: Math.max(0, Math.min(1, event.target.valueAsNumber / 100)) })}/><i>%</i></label><label><span>{text(language, "Fill", "Заливка")}</span><input type="number" min="0" max="100" value={Math.round((activeLayer.fillOpacity ?? 1) * 100)} onChange={(event) => updateActive({ fillOpacity: Math.max(0, Math.min(1, event.target.valueAsNumber / 100)) })}/><i>%</i></label></div></div>
      <div className="layer-list">{[...state.layers].reverse().map((layer) => <div className={[layer.id === state.activeLayerId ? "active" : "", selectedLayerIds.includes(layer.id) ? "selected" : "", "layer-row"].filter(Boolean).join(" ")} key={layer.id}><button onClick={() => toggleVisible(layer.id)} aria-label={text(language, "Toggle visibility", "Переключить видимость")}><img src={layer.visible ? "/ГЛАЗ ОТКРЫТ.svg" : "/ГЛАЗ ЗАКРЫТ.svg"} alt=""/></button><button onClick={(event) => clickLayer(layer.id, event)} onDoubleClick={() => { selectLayer(layer.id); setStyleLayerId(layer.id); }}><LayerThumbnail layer={layer}/><span className="layer-row-text"><b>{localized(layer.name, language)}</b><small>{layer.blendMode} · {Math.round(layer.opacity * 100)}%</small></span></button></div>)}</div>
      <div className="layer-actions adjustment-actions">{showAdjustments && <div className="adjustment-menu">{adjustmentLabels.map(([kind, name]) => <button key={kind} onClick={() => addAdjustment(kind, name)}>{name}</button>)}</div>}<button onClick={() => setShowAdjustments((value) => !value)} title={text(language, "New adjustment layer", "Новый корректирующий слой")}><img src="/КОРРЕКТИРУЮЩИЙ СЛОЙ.svg" alt=""/></button><button onClick={addLayer} title={text(language, "New layer", "Новый слой")}><img src="/НОВЫЙ СЛОЙ.svg" alt=""/></button><button onClick={deleteLayer} title={text(language, "Delete layer", "Удалить слой")}><img src="/КОРЗИНА.svg" alt=""/></button></div>
      {styleLayer && <LayerStyleDialog layer={styleLayer} onClose={() => setStyleLayerId(null)} onApply={(patch) => kernel.documents.update<RasterDocumentState>(active.id, (current) => { const target = current.layers.find((layer) => layer.id === styleLayer.id); if (target) Object.assign(target, patch); })}/>} 
    </div>;
  }
  return <div className="dock-panel-body"><button className="panel-action">＋ {timed ? text(language, "Track", "Дорожка") : text(language, "Layer", "Слой")}</button><div className="empty-row">{timed ? text(language, "No tracks yet", "Дорожек пока нет") : text(language, "No layers yet", "Слоёв пока нет")}</div></div>;
}

function HistoryPanel() {
  const language = useShellStore((state) => state.language);
  return <div className="dock-panel-body"><div className="history-entry active">● {text(language, "Open document", "Открыть документ")}</div></div>;
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
};

const panelIcons: Record<string, string> = { properties: "/ПАРАМЕТРЫ.svg", layers: "/СЛОИ.svg", history: "/НАЗАД.svg", assets: "/КВАДРАТ.svg", effects: "/ЭФЕКТЫ.svg", viewport: "/РАДИО.svg" };
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
  const properties = event.api.addPanel({ id: "properties", component: "inspector", title: text(language, "Properties", "Свойства"), position: { referenceGroup: sideGroup.id, direction: "within" } });
  event.api.addPanel({ id: "layers", component: "layers", title: text(language, "Layers / Tracks", "Слои / Дорожки"), position: { referencePanel: properties, direction: "within" } });
  event.api.addPanel({ id: "history", component: "history", title: text(language, "History", "История"), position: { referencePanel: properties, direction: "within" } });
  event.api.addPanel({ id: "assets", component: "assets", title: text(language, "Assets", "Ассеты"), position: { referencePanel: properties, direction: "within" } });
}

export function DockLayout() {
  const language = useShellStore((state) => state.language);
  const onReady = useCallback((event: DockviewReadyEvent) => {
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
    event.api.onDidLayoutChange(() => localStorage.setItem(storageKey, JSON.stringify(event.api.toJSON())));
  }, [language]);

  return <div className="dock-host"><DockviewReact key={language} theme={themeDark} components={components} defaultTabComponent={PanelTab} rightHeaderActionsComponent={PanelHeaderActions} onReady={onReady} /></div>;
}
