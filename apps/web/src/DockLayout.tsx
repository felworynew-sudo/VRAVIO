import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { DockviewReact, themeDark, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from "dockview-react";
import type { DockviewReadyEvent, SerializedDockview } from "dockview";
import { environmentMeta } from "./environment";
import { useShellStore } from "./store";
import { useDocuments } from "./useDocuments";
import { RasterWorkspace } from "./RasterWorkspace";
import { VectorWorkspace } from "./VectorWorkspace";
import { AudioWorkspace } from "./AudioWorkspace";
import { VideoWorkspace } from "./VideoWorkspace";
import { appendLayer, appendRasterGroup, compositeRasterDocument, createAdjustmentLayer, createRasterLayer, createRasterLayerMask, createRasterLayerMaskFromSelection, defaultScene3DGround, isRasterDocumentState, layerDocumentPixels, punchSelectionIntoMask, rasterLayerDescendantIds, rasterLayerRows, renderLayerEffects, setLayerPixels, dropPositionInRow, dropTargetForRow, placeLayer, toggleLayerLink, type RasterBlendMode, type RasterDocumentState, type RasterLayer, type RasterLayerEffects, type RasterLayerMask } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { localized, text } from "./i18n";
import { renderTextLayerPixels } from "./textRender";
import { ColorPanel } from "./ColorPanel";
import { NavigatorPanel } from "./NavigatorPanel";
import { ScriptsPanel } from "./scripts/ScriptsPanel";
import type { Language } from "./store";
import { rasterAdjustmentById, rasterAdjustments } from "./raster-adjustments/registry";
import { environmentsWithWindows, windowById, windowsFor } from "./windows/registry";
import { windowTitle } from "./windows/types";
import { PANEL_REQUEST_EVENT, persistVisiblePanelIds, readVisiblePanelIds, type PanelVisibilityDetail } from "./windows/runtime";
import { addPaletteColor, clearGuides, deleteArtboard, duplicateArtboard, isVectorDocumentState, listSymbols, rearrangeArtboardsGrid, renameArtboard, renamePaletteColor, reorderArtboard, removePaletteColor, setArtboardBleed, setRulerMode, shapeBounds, updateShape, vectorShapeRows, type Artboard, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
import { colorToCss, cssToColor, type EnvironmentKind } from "@vravio/kernel";
import { cloneAudioState, isAudioDocumentState, type AudioDocumentState, type FadeType } from "@vravio/env-audio";
import { commitAudioDrag, previewMoveClip, setClipFade, setClipGain } from "./audio-commands";
import { vectorTextMeasurer } from "./vector-text-metrics";
import { changeVectorDocument, createSymbolFromActiveSelection, deleteActiveVectorShapes, detachActiveVectorInstance, duplicateActiveVectorShape, groupActiveVectorShapes, placeVectorSymbolInstance, redefineSymbolFromActiveSelection, reorderActiveVectorShape, ungroupActiveVectorGroup } from "./vector-commands";
import { validateIccProfile } from "./vector-color-wasm";
import { exportVectorDocumentToSvg } from "./vector-svg-export";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { luminanceHistogram } from "./raster-adjustments/histogram";
import { changeRasterDocument, changeRasterSelection } from "./commands";
import { useIconCursor } from "./icon-cursor";
import { confirmModal } from "./modals/runtime";
import { useCloseOnOutsideClick } from "./useCloseOnOutsideClick";
import { WORKSPACE_LAYOUT_STORAGE_KEY, WORKSPACE_PRESET_EVENT, selectedWorkspacePreset, workspacePresetById, type WorkspacePresetDetail } from "./workspace-presets";
import { pickCommands } from "./commands/surface";
import { convertLayerToScene3D, importModelAsLayer, updateScene3DLayer } from "./scene3d-commands";
import { AngleDial } from "./AngleDial";
import { Scene3DMiniPreview } from "./Scene3DMiniPreview";
import type { ReversibleOperation } from "@vravio/kernel";
import { AppearancePanel } from "./environments/vector/AppearancePanel";
import { GeometryModifiersPanel } from "./environments/vector/GeometryModifiersPanel";
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

const LAYOUT_STORAGE_KEY = WORKSPACE_LAYOUT_STORAGE_KEY;
const PANEL_RAIL_LABELS_KEY = "vravio.panel-rail-labels";
const PANEL_RAIL_LABELS_EVENT = "vravio-panel-rail-labels-change";
// Dockview's own `DockviewGroupPanel` bakes in a 100px floor for every grid
// group (`MINIMUM_DOCKVIEW_GROUP_PANEL_WIDTH`) — a `setSize({ width: 35 })`
// call alone is silently clamped back up to 100px, so a "collapsed to icons"
// rail never actually reaches the compact width the code asked for (found
// live: the rail rendered ~100px wide with its content visibly cramped, not
// the intended icon strip). `setConstraints` is the escape hatch Dockview
// itself provides for exactly this — it overrides the floor per group, and
// is on the same public `GridviewPanelApi` interface `setSize` is, no cast
// needed. Every `setSize` that targets the rail width must be paired with a
// matching `setConstraints` first, or the resize is silently ignored again.
const GRID_RAIL_MIN_WIDTH = 35;
const GRID_RAIL_LABELS_MIN_WIDTH = 132;
const GRID_EXPANDED_MIN_WIDTH = 220;
const EMPTY_LAYER_SELECTION: string[] = [];
/** The shell owns the Tab shortcut; DockLayout owns the actual edge dock. */
export const CLEAN_CANVAS_EVENT = "vravio-clean-canvas";

/**
 * The Photoshop reference (информация.txt point "панели... занимают такую же высоту что и
 * тулбар") docks the document-tab strip, the tool options bar and the status bar to the
 * *canvas column specifically* — they never span the full window width the way `.toolbar`'s
 * own dedicated grid row did, which is exactly why the side panels used to stop short of the
 * toolbar's full height: `App.tsx`'s outer CSS grid gave `.toolbar` its own row spanning
 * menu-to-bottom, but boxed everything else (including the dock host, panels and all) into
 * the single `workspace` row sandwiched between the tabs/options/status rows.
 *
 * The fix is App.tsx's tabs/options/status JSX staying exactly where it is — same component,
 * same local state, nothing re-plumbed — but rendered through a portal into slots that live
 * *inside* `ViewportPanel`'s own DOM, so their width tracks the canvas column instead of the
 * whole app. `ViewportPanel` mounts once per environment switch (a fresh Dockview panel
 * instance each time, since it isn't restored via `fromJSON` params — those don't survive
 * `JSON.stringify`, being callbacks), so a plain module-level registry + subscriber hook is
 * simpler and more robust here than threading refs through Dockview's own panel `params`.
 */
export interface CanvasChromeSlots { readonly top: HTMLDivElement | null; readonly bottom: HTMLDivElement | null }
const EMPTY_CHROME_SLOTS: CanvasChromeSlots = { top: null, bottom: null };
let canvasChromeSlots: CanvasChromeSlots = EMPTY_CHROME_SLOTS;
const canvasChromeSlotListeners = new Set<(slots: CanvasChromeSlots) => void>();
function setCanvasChromeSlot(name: keyof CanvasChromeSlots, node: HTMLDivElement | null): void {
  canvasChromeSlots = { ...canvasChromeSlots, [name]: node };
  for (const listener of canvasChromeSlotListeners) listener(canvasChromeSlots);
}
export function useCanvasChromeSlots(): CanvasChromeSlots {
  const [slots, setSlots] = useState(canvasChromeSlots);
  useEffect(() => {
    canvasChromeSlotListeners.add(setSlots);
    return () => { canvasChromeSlotListeners.delete(setSlots); };
  }, []);
  return slots;
}

function ViewportPanel() {
  const documents = useDocuments();
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const active = documents.find((document) => document.id === activeDocumentId) ?? null;

  const workspace = !active ? null
    : active.kind === "raster" ? <RasterWorkspace document={active} />
    : active.kind === "vector" ? <VectorWorkspace document={active} />
    : active.kind === "audio" ? <AudioWorkspace document={active} />
    : <VideoWorkspace document={active} />;
  return <div className="viewport-chrome">
    <div className="viewport-chrome-top" ref={(node) => setCanvasChromeSlot("top", node)}/>
    <div className="viewport-chrome-canvas">{workspace}</div>
    <div className="viewport-chrome-bottom" ref={(node) => setCanvasChromeSlot("bottom", node)}/>
  </div>;
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
      if (definition) { const index = rasterState.layers.findIndex((item) => item.id === layer.id), pixels = compositeRasterDocument({ ...rasterState, layers: rasterState.layers.slice(0, Math.max(0, index)) }); return <div className="dock-panel-body property-stack adjustment-properties"><header><img src={iconUrl(definition.icon)} alt=""/><strong>{language === "ru" ? definition.name.ru : definition.name.en}</strong></header><definition.Editor value={adjustment} language={language} histogram={luminanceHistogram(pixels)} onChange={(next) => { const before = adjustment, targetId = layer.id; const write = (value: typeof adjustment) => kernel.documents.update<RasterDocumentState>(document.id, (state) => { const current = state.layers.find((item) => item.id === targetId); if (current?.adjustment) current.adjustment = value; }); write(next); const history = kernel.historyByDocument.get(document.id); if (history) void history.record(mergeableEdit(`Adjustment: ${language === "ru" ? definition.name.ru : definition.name.en}`, () => write(before), () => write(next)), true); }}/></div>; }
    }
    if (layer?.kind === "3d" && layer.scene3d) return <Scene3DProperties documentId={document.id} document={rasterState} layer={layer} language={language} />;
  }
  if (document && isVectorDocumentState(document.state)) {
    const vectorState = document.state;
    const shape = vectorState.shapes.find((item) => item.id === vectorState.activeShapeId);
    if (shape) {
      const bounds = shapeBounds(shape, vectorTextMeasurer);
      const commit = (patch: Partial<VectorShape>) => void changeVectorDocument(document.id, "Edit Shape (Изменить фигуру)", (state) => { updateShape<VectorShape>(state, shape.id, patch); return true; });
      const commitStyle = (patch: Partial<VectorShape["style"]>) => commit({ style: { ...shape.style, ...patch } } as Partial<VectorShape>);
      return <div className="dock-panel-body property-stack vector-properties">
        <strong>{shape.name}</strong>
        <label>{text(language, "Name", "Имя")}<input value={shape.name} onChange={(event) => commit({ name: event.target.value })} /></label>
        <div className="parameter-pair">
          <label>X<input type="number" value={Math.round(bounds.x)} onChange={(event) => commit(shape.kind === "line" ? { x1: shape.x1 + (event.target.valueAsNumber - bounds.x), x2: shape.x2 + (event.target.valueAsNumber - bounds.x) } : { x: event.target.valueAsNumber })} /></label>
          <label>Y<input type="number" value={Math.round(bounds.y)} onChange={(event) => commit(shape.kind === "line" ? { y1: shape.y1 + (event.target.valueAsNumber - bounds.y), y2: shape.y2 + (event.target.valueAsNumber - bounds.y) } : { y: event.target.valueAsNumber })} /></label>
        </div>
        {(shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "image") && <div className="parameter-pair">
          <label>{text(language, "Width", "Ширина")}<input type="number" min={1} value={Math.round(shape.width)} onChange={(event) => commit({ width: Math.max(1, event.target.valueAsNumber) })} /></label>
          <label>{text(language, "Height", "Высота")}<input type="number" min={1} value={Math.round(shape.height)} onChange={(event) => commit({ height: Math.max(1, event.target.valueAsNumber) })} /></label>
        </div>}
        {shape.kind === "rectangle" && <label>{text(language, "Corner radius", "Радиус углов")}<input type="number" min={0} value={shape.cornerRadius} onChange={(event) => commit({ cornerRadius: Math.max(0, event.target.valueAsNumber) })} /></label>}
        {shape.kind === "text" && <>
          <label>{text(language, "Text", "Текст")}<textarea value={shape.value} onChange={(event) => commit({ value: event.target.value })} /></label>
          <label>{text(language, "Font size", "Размер шрифта")}<input type="number" min={1} value={shape.fontSize} onChange={(event) => commit({ fontSize: Math.max(1, event.target.valueAsNumber) })} /></label>
          {/* Stage 11's text-in-frame: empty/0 means point text (the
              original behaviour, `frameWidth: null`) — a real number turns
              this into area type, wrapping `value` to fit. Panel-based,
              not a canvas drag-to-create-frame gesture — the same
              "real and undoable, not polished" tradeoff this file's other
              `window.prompt`-based actions already make. */}
          <label>{text(language, "Frame width (0 = point text)", "Ширина рамки (0 — точечный текст)")}<input type="number" min={0} value={shape.frameWidth ?? 0} onChange={(event) => commit({ frameWidth: event.target.valueAsNumber > 0 ? event.target.valueAsNumber : null })} /></label>
        </>}
        {shape.kind === "image" && <button className="secondary-action" onClick={() => void kernel.commands.execute("image.openElsewhere", { activeDocumentId: document.id })}>{text(language, "Edit in Raster Environment…", "Открыть в растровой среде…")}</button>}
        {shape.kind !== "image" && <AppearancePanel style={shape.style} language={language} onChange={(style) => commitStyle(style)}/>}
        {(shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "path") &&
          <GeometryModifiersPanel shape={shape} allShapes={vectorState.shapes} language={language} onChange={(geometry) => commit({ geometry } as Partial<VectorShape>)}/>}
      </div>;
    }
    return <div className="dock-panel-body"><p className="panel-hint">{text(language, "Select a shape to see its properties.", "Выберите фигуру, чтобы увидеть её свойства.")}</p></div>;
  }
  if (document && isAudioDocumentState(document.state)) return <AudioInspector documentId={document.id} state={document.state} language={language} />;
  return <div className="dock-panel-body"><p className="panel-hint">{text(language, "Selection-aware properties will appear here.", "Здесь будут отображаться свойства текущего выделения.")}</p><dl><dt>{text(language, "Selection", "Выделение")}</dt><dd>{text(language, "None", "Нет")}</dd><dt>{text(language, "Environment", "Среда")}</dt><dd>{String(params.kind ?? text(language, "Automatic", "Автоматически"))}</dd></dl></div>;
}

/**
 * The audio Inspector — Ardour's editor-mixer-strip idea, scaled to what a clip actually needs
 * numerically edited rather than dragged: nothing here duplicates a track header control
 * (name/mute/solo/FX toggle/volume/pan sliders already live in `AudioWorkspace.tsx`'s own track
 * headers) or the inline FX chain strip that toggling a track's "FX" button already opens —
 * this shows exactly what neither of those does: a selected clip's exact numeric position,
 * gain and fades, or, with nothing selected, the project's own format.
 */
function AudioInspector({ documentId, state, language }: { documentId: string; state: AudioDocumentState; language: Language }) {
  const track = state.selection ? state.tracks.find((item) => item.id === state.selection!.trackId) : undefined;
  const clip = track && state.selection?.clipIds.length === 1 ? track.clips.find((item) => item.id === state.selection!.clipIds[0]) : undefined;
  if (!track || !clip) return <div className="dock-panel-body property-stack">
    <strong>{text(language, "Project", "Проект")}</strong>
    <dl><dt>{text(language, "Sample rate", "Частота дискретизации")}</dt><dd>{state.sampleRate.toLocaleString()} Hz</dd>
      <dt>{text(language, "Channels", "Каналы")}</dt><dd>{state.channels === 1 ? text(language, "Mono", "Моно") : text(language, "Stereo", "Стерео")}</dd>
      <dt>{text(language, "Bit depth", "Разрядность")}</dt><dd>{state.bitDepth}-bit</dd>
      <dt>{text(language, "Tracks", "Дорожек")}</dt><dd>{state.tracks.length}</dd></dl>
    <p className="panel-hint">{text(language, "Select a single clip to see its properties.", "Выберите один клип, чтобы увидеть его свойства.")}</p>
  </div>;

  const sr = state.sampleRate;
  const toSeconds = (samples: number) => samples / sr;
  const setStartSeconds = (seconds: number) => {
    const targetSample = Math.max(0, Math.round(seconds * sr));
    const before = cloneAudioState(state);
    previewMoveClip(documentId, track.id, clip.id, targetSample - clip.startSample);
    commitAudioDrag(documentId, "Move Clip (Переместить клип)", before);
  };
  const setGain = (gain: number) => setClipGain(documentId, track.id, clip.id, gain);
  const setFade = (edge: "in" | "out", seconds: number, fadeType?: FadeType) => setClipFade(documentId, track.id, clip.id, edge, Math.round(seconds * sr), fadeType);
  const fadeTypes: { value: FadeType; en: string; ru: string }[] = [
    { value: "linear", en: "Linear", ru: "Линейный" }, { value: "exponential", en: "Exponential", ru: "Экспоненциальный" },
    { value: "sCurve", en: "S-Curve", ru: "S-кривая" }, { value: "logarithmic", en: "Logarithmic", ru: "Логарифмический" },
  ];

  return <div className="dock-panel-body property-stack">
    <strong>{clip.name}</strong>
    <label>{text(language, "Name", "Имя")}<input value={clip.name} onChange={(event) => void (async () => { const before = cloneAudioState(state); const next = event.target.value; kernel.documents.update<AudioDocumentState>(documentId, (draft) => { const found = draft.tracks.find((t) => t.id === track.id)?.clips.find((c) => c.id === clip.id); if (found) found.name = next; }); commitAudioDrag(documentId, "Rename Clip (Переименовать клип)", before); })()} /></label>
    <div className="parameter-pair">
      <label>{text(language, "Start", "Начало")}<input type="number" step="0.001" min={0} value={Number(toSeconds(clip.startSample).toFixed(3))} onChange={(event) => setStartSeconds(event.target.valueAsNumber)} /></label>
      <label>{text(language, "Duration", "Длительность")}<input type="number" step="0.001" value={Number(toSeconds(clip.durationSamples).toFixed(3))} readOnly title={text(language, "Drag a clip's edge on the timeline to trim it", "Потяните край клипа на таймлайне, чтобы обрезать")} /></label>
    </div>
    <label>{text(language, "Gain", "Громкость")}<input type="range" min={0} max={2} step={0.01} value={clip.gain} onChange={(event) => setGain(event.target.valueAsNumber)} /><output>{clip.gain.toFixed(2)}×</output></label>
    <strong>{text(language, "Fades", "Фейды")}</strong>
    <label>{text(language, "Fade type", "Тип фейда")}<select value={clip.fadeType} onChange={(event) => setFade("in", toSeconds(clip.fadeInSamples), event.target.value as FadeType)}>{fadeTypes.map((entry) => <option key={entry.value} value={entry.value}>{text(language, entry.en, entry.ru)}</option>)}</select></label>
    <div className="parameter-pair">
      <label>{text(language, "Fade in (s)", "Появление (с)")}<input type="number" step="0.001" min={0} value={Number(toSeconds(clip.fadeInSamples).toFixed(3))} onChange={(event) => setFade("in", event.target.valueAsNumber)} /></label>
      <label>{text(language, "Fade out (s)", "Затухание (с)")}<input type="number" step="0.001" min={0} value={Number(toSeconds(clip.fadeOutSamples).toFixed(3))} onChange={(event) => setFade("out", event.target.valueAsNumber)} /></label>
    </div>
  </div>;
}

/** Properties panel for a persistent 3D layer: rotation, lighting and (source-dependent)
 * material controls, each committing through updateScene3DLayer — which re-renders the layer's
 * pixels on every change, the same "edit the data, not the pixels" contract a text layer has.
 *
 * `commit` coalesces to one call per animation frame instead of one per `input` event: a
 * `<input type="range">` fires that event continuously while dragging, and each call into
 * `updateScene3DLayer` is a full mesh rebuild + WebGL render + `readPixels` + document commit —
 * exactly the unthrottled-per-frame-cost pattern already fixed once this session for the
 * adjustment dialog's live preview, reproduced here on a 3D re-render instead of a flat
 * composite. Coalesced patches merge field-by-field for `lighting`/`source` rather than one
 * overwriting the other's nested object outright: two different sliders (say azimuth then
 * elevation) dragged within the same animation frame both read the same still-stale `data` —
 * the first commit hasn't landed yet — so a shallow merge would drop whichever field's own
 * patch got overwritten by the other's freshly-spread-but-incomplete `lighting` object. */
function Scene3DProperties({ documentId, document, layer, language }: { documentId: string; document: RasterDocumentState; layer: RasterLayer; language: Language }) {
  const data = layer.scene3d!;
  const pendingRef = useRef<{ frame: number; patch: Partial<typeof data> } | null>(null);
  const commit = (patch: Partial<typeof data>) => {
    const pending = pendingRef.current;
    if (pending) {
      pending.patch = {
        ...pending.patch, ...patch,
        ...(pending.patch.lighting || patch.lighting ? { lighting: { ...pending.patch.lighting, ...patch.lighting } as typeof data.lighting } : {}),
        ...(pending.patch.source || patch.source ? { source: { ...pending.patch.source, ...patch.source } as typeof data.source } : {}),
      };
      return;
    }
    const entry = { frame: 0, patch };
    pendingRef.current = entry;
    entry.frame = requestAnimationFrame(() => {
      pendingRef.current = null;
      void updateScene3DLayer(documentId, layer.id, entry.patch);
    });
  };
  const commitLighting = (patch: Partial<typeof data.lighting>) => commit({ lighting: { ...data.lighting, ...patch } });
  const commitSource = (patch: Partial<typeof data.source>) => commit({ source: { ...data.source, ...patch } as typeof data.source });
  const ground = data.ground ?? { ...defaultScene3DGround, distance: data.size * 0.3 };
  const commitGround = (patch: Partial<typeof ground>) => commit({ ground: { ...ground, ...patch } });
  return <div className="dock-panel-body property-stack scene3d-properties">
    <strong>{text(language, "3D Layer", "3D-слой")}</strong>
    {data.source.kind === "text" && <>
      <label>{text(language, "Text", "Текст")}<input value={data.source.value} onChange={(event) => commitSource({ value: event.target.value })}/></label>
      <label>{text(language, "Extrusion Depth", "Глубина экструзии")}<input type="range" min={0} max={80} value={data.source.depth} onChange={(event) => commitSource({ depth: event.target.valueAsNumber })}/><output>{data.source.depth}</output></label>
      <label className="export-check"><input type="checkbox" checked={data.source.bevelEnabled} onChange={(event) => commitSource({ bevelEnabled: event.target.checked })}/>{text(language, "Bevel", "Фаска")}</label>
    </>}
    {data.source.kind === "extrude" && <label>{text(language, "Extrusion Depth", "Глубина экструзии")}<input type="range" min={0} max={200} value={data.source.depth} onChange={(event) => commitSource({ depth: event.target.valueAsNumber })}/><output>{data.source.depth}</output></label>}
    {data.source.kind === "model" && <div className="panel-hint">{text(language, "Model", "Модель")}: {data.source.fileName}</div>}
    {data.source.kind !== "model" && <>
      <label>{text(language, "Size", "Размер")}<input type="range" min={10} max={400} value={data.size} onChange={(event) => commit({ size: event.target.valueAsNumber })}/><output>{data.size}</output></label>
      <label>{text(language, "Color", "Цвет")}<input type="color" value={data.color} onChange={(event) => commit({ color: event.target.value })}/></label>
      <label>{text(language, "Metalness", "Металличность")}<input type="range" min={0} max={1} step={0.05} value={data.metalness} onChange={(event) => commit({ metalness: event.target.valueAsNumber })}/><output>{data.metalness}</output></label>
      <label>{text(language, "Roughness", "Шероховатость")}<input type="range" min={0} max={1} step={0.05} value={data.roughness} onChange={(event) => commit({ roughness: event.target.valueAsNumber })}/><output>{data.roughness}</output></label>
    </>}
    {/* The owner's own sketch: a mini live preview in the middle, rotation dials to its left,
        light dials to its right — Scene3DMiniPreview.tsx and AngleDial.tsx are the two pieces
        this needed that did not exist anywhere in the app yet (a persistent-session panel
        preview; a generic drag-a-ring-to-set-a-value control, generalizing the brush tip's own
        angle handle rather than becoming a second copy of the same trig). */}
    <div className="scene3d-properties-cluster">
      <div className="scene3d-dial-column">
        <div className="scene3d-dial-row"><AngleDial value={data.rotationX} min={-180} max={180} onChange={(value) => commit({ rotationX: value })} title={text(language, "Rotate X", "Вращение X")}/><span>X</span><output>{Math.round(data.rotationX)}°</output></div>
        <div className="scene3d-dial-row"><AngleDial value={data.rotationY} min={-180} max={180} onChange={(value) => commit({ rotationY: value })} title={text(language, "Rotate Y", "Вращение Y")}/><span>Y</span><output>{Math.round(data.rotationY)}°</output></div>
        <div className="scene3d-dial-row"><AngleDial value={data.rotationZ} min={-180} max={180} onChange={(value) => commit({ rotationZ: value })} title={text(language, "Rotate Z", "Вращение Z")}/><span>Z</span><output>{Math.round(data.rotationZ)}°</output></div>
      </div>
      <Scene3DMiniPreview document={document} data={data}/>
      <div className="scene3d-dial-column">
        <div className="scene3d-dial-row"><AngleDial value={data.lighting.azimuth} min={-180} max={180} onChange={(value) => commitLighting({ azimuth: value })} title={text(language, "Light Azimuth", "Свет: азимут")}/><span>⟳</span><output>{Math.round(data.lighting.azimuth)}°</output></div>
        <div className="scene3d-dial-row"><AngleDial value={data.lighting.elevation} min={0} max={90} onChange={(value) => commitLighting({ elevation: value })} title={text(language, "Light Elevation", "Свет: высота")}/><span>↕</span><output>{Math.round(data.lighting.elevation)}°</output></div>
        <div className="scene3d-dial-row"><AngleDial value={data.lighting.directionalIntensity} min={0} max={4} onChange={(value) => commitLighting({ directionalIntensity: value })} title={text(language, "Light Intensity", "Яркость света")}/><span>💡</span><output>{data.lighting.directionalIntensity.toFixed(1)}</output></div>
      </div>
    </div>
    <label className="export-check"><input type="checkbox" checked={ground.enabled} onChange={(event) => commitGround({ enabled: event.target.checked })}/>{text(language, "Shadow on surface", "Тень на поверхность")}</label>
    <strong>{text(language, "Lighting", "Освещение")}</strong>
    <label>{text(language, "Light Color", "Цвет света")}<input type="color" value={data.lighting.directionalColor} onChange={(event) => commitLighting({ directionalColor: event.target.value })}/></label>
    <label>{text(language, "Ambient Intensity", "Рассеянный свет")}<input type="range" min={0} max={2} step={0.05} value={data.lighting.ambientIntensity} onChange={(event) => commitLighting({ ambientIntensity: event.target.valueAsNumber })}/><output>{data.lighting.ambientIntensity}</output></label>
    {ground.enabled && <>
      {/* Numeric fallback for tiltX/distance — tiltZ has no slider here (only the on-canvas point-placement flow, Scene3DGroundPointsGizmo.tsx, sets it), matching the owner's own request to keep this panel plain until a redesigned one replaces it. Either door commits through the same updateScene3DLayer call. */}
      <label>{text(language, "Surface Tilt", "Наклон поверхности")}<input type="range" min={0} max={90} value={ground.tiltX} onChange={(event) => commitGround({ tiltX: event.target.valueAsNumber })}/><output>{Math.round(ground.tiltX)}°</output></label>
      <label>{text(language, "Surface Distance", "Расстояние до поверхности")}<input type="range" min={0} max={Math.max(ground.distance * 2, data.size)} value={ground.distance} onChange={(event) => commitGround({ distance: event.target.valueAsNumber })}/><output>{Math.round(ground.distance)}</output></label>
      <label>{text(language, "Shadow Opacity", "Непрозрачность тени")}<input type="range" min={0} max={100} value={ground.opacity} onChange={(event) => commitGround({ opacity: event.target.valueAsNumber })}/><output>{Math.round(ground.opacity)}%</output></label>
      <label>{text(language, "Shadow Softness", "Мягкость тени")}<input type="range" min={0} max={20} value={ground.softness} onChange={(event) => commitGround({ softness: event.target.valueAsNumber })}/><output>{Math.round(ground.softness)}</output></label>
    </>}
    {data.source.kind === "model" && <button className="secondary-action" onClick={() => { const input = window.document.createElement("input"); input.type = "file"; input.accept = ".obj,.glb,.gltf"; input.onchange = () => { const file = input.files?.[0]; if (file) void importModelAsLayer(documentId, file); }; input.click(); }}>{text(language, "Replace Model…", "Заменить модель…")}</button>}
  </div>;
}

/** Root-relative icon paths (e.g. "/ГРУППА.svg") 404 under GitHub Pages'
 *  own `/VRAVIO/` base — always route them through Vite's `BASE_URL`. */
function iconUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}

function rasterizeTextLayer(layer: RasterLayer, width: number, height: number): void {
  if (!layer.text) return;
  setLayerPixels(layer, renderTextLayerPixels(layer.text, width, height), width, height);
}

/** The glyph that says what kind of layer this is, or nothing for a plain one. */
function layerKindIcon(layer: RasterLayer): string | null {
  if (layer.kind === "text") return iconUrl("/СЛОЙ-ТЕКСТ.svg");
  if (layer.kind === "adjustment") return iconUrl(layer.adjustment ? rasterAdjustmentById.get(layer.adjustment.kind)?.icon ?? "/КОРРЕКТИРУЮЩИЙ СЛОЙ.svg" : "/КОРРЕКТИРУЮЩИЙ СЛОЙ.svg");
  if (layer.kind === "shape") return iconUrl("/СЛОЙ-ФИГУРА.svg");
  if (layer.kind === "smart") return iconUrl("/СЛОЙ-СМАРТ.svg");
  if (layer.kind === "3d") return iconUrl("/СЛОЙ-3D.svg");
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
  if (layer.kind === "group") return <span className="layer-thumb layer-group-thumb"><img src={iconUrl("/ГРУППА.svg")} alt=""/></span>;
  return <span className={`layer-thumb${active ? " editing" : ""}`} onClick={(event) => { event.stopPropagation(); onActivate?.(); }}>{layerKindIcon(layer) && <img className="layer-kind-icon" src={layerKindIcon(layer)!} alt="" width={13} height={13}/>}<canvas ref={ref} width="36" height="28" /></span>;
}

function LayerMaskThumbnail({ mask, width, height, active, onActivate, onDragStart }: { mask: RasterLayerMask; width: number; height: number; active: boolean; onActivate(): void; onDragStart(event: React.PointerEvent): void }) {
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
  return <span className={`layer-mask-thumb${active ? " editing" : ""}`} title="Edit Layer Mask (Редактировать маску слоя)" onClick={(event) => { event.stopPropagation(); onActivate(); }} onPointerDown={onDragStart}><canvas ref={ref} width="28" height="28"/></span>;
}

/**
 * master-plan.md §1.9 item 6's Copy/Paste Mask and Copy/Paste Layer Style —
 * an in-memory clipboard, not the system one: this is structured internal
 * state (a mask's own pixel buffer, an effects object), not text or an
 * image a plugin outside this app could plausibly want. Module-level, not
 * per-document, matching `select.ts`'s own `lastSelectionByDocument`
 * pattern for the same kind of "remember this until the next paste" state —
 * a real clipboard is global too, not scoped to whichever document you
 * copied from.
 */
let copiedLayerMask: RasterLayerMask | null = null;
let copiedLayerStyle: RasterLayerEffects | null = null;

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

/** Shared with the layers panel's own fx disclosure list (LayersPanel below) — one
 * name per effect key, so the dialog and the panel can never drift into calling the
 * same effect two different things (CLAUDE.md's "duplicate is two futures" rule). */
const LAYER_STYLE_SECTIONS = [["blending", "Blending Options (Параметры смешивания)"], ["bevel", "Bevel & Emboss (Рельеф и тиснение)"], ["innerShadow", "Inner Shadow (Внутренняя тень)"], ["innerGlow", "Inner Glow (Внутреннее свечение)"], ["gradientOverlay", "Gradient Overlay (Наложение градиента)"], ["outerGlow", "Outer Glow (Внешнее свечение)"], ["dropShadow", "Drop Shadow (Тень)"]] as const;

function LayerStyleDialog({ layer, onApply, onClose }: { layer: RasterLayer; onApply(patch: Partial<RasterLayer>): void; onClose(): void }) {
  const [section, setSection] = useState<"blending" | keyof RasterLayer["effects"]>("blending");
  const [draft, setDraft] = useState(() => structuredClone(layer.effects));
  const [blendMode, setBlendMode] = useState(layer.blendMode), [opacity, setOpacity] = useState(layer.opacity), [fillOpacity, setFillOpacity] = useState(layer.fillOpacity ?? 1);
  const items = LAYER_STYLE_SECTIONS;
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
  const [expandedFxIds, setExpandedFxIds] = useState<ReadonlySet<string>>(new Set());
  const toggleFxExpanded = (id: string) => setExpandedFxIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  /** Every effect a layer has actually configured (present in `layer.effects`, from
   * having visited that section of the style dialog at least once), whether its own
   * `enabled` flag is currently on or off — Photoshop keeps a configured effect in
   * the fx list with a closed eye rather than dropping it, so switching one off
   * doesn't also make it (or the badge, if it was the last one) vanish. The badge/
   * disclosure a layer with none of them never renders, matching CLAUDE.md's "a
   * setting that does nothing is worse than no setting" (an empty fx list would be
   * exactly that). */
  const configuredLayerEffects = (layer: RasterLayer) => LAYER_STYLE_SECTIONS.filter(([key]) => key !== "blending").flatMap(([key, label]) => { const effect = layer.effects?.[key as keyof RasterLayerEffects]; return effect ? [{ key: key as keyof RasterLayerEffects, label, enabled: effect.enabled }] : []; });
  const [showAdjustments, setShowAdjustments] = useState(false);
  // `position:fixed` in viewport coordinates, computed from the toggle
  // button's own rect — not the panel-relative `position:absolute` this
  // used to be. A dockview panel clips its own overflow (it has to, to
  // scroll), and this menu opens *upward* from a button that can sit near a
  // panel's own top edge — docking Layers under Properties, reported live
  // by the owner, is exactly that: the list's upper rows landed above the
  // panel's own top and were clipped there before ever reaching the screen
  // edge. `.context-menu` (ContextMenu.tsx) already solved this the same
  // way for the same reason; this reuses that, not a second fix invented
  // for one more floating menu.
  const adjustmentToggleRef = useRef<HTMLButtonElement>(null);
  const [adjustmentMenuAnchor, setAdjustmentMenuAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  // master-plan.md §1.9 items 9+14 (merged — the owner said they're the same
  // feature): holding Ctrl and hovering the boundary just below a layer row
  // swaps the cursor to a dedicated icon; Ctrl-clicking there toggles
  // clipping for that layer against the one below it, the same effect as
  // layer.toggleClippingMask (see clickLayer below, which is where the
  // actual toggle happens — this only tracks which boundary is "armed").
  const [clippingHoverId, setClippingHoverId] = useState<string | null>(null);
  // Ctrl over the seam between two rows arms the clipping gesture; the cursor has
  // to say so, which is what the owner asked for. Same icon the row shows once a
  // layer IS clipped, so the promise and the result look alike. Straight
  // `cursor: url("…svg")` on it did nothing at all: the file is 640x320 and a
  // browser drops any cursor image past ~128px without a word (see icon-cursor.ts).
  const clippingCursor = useIconCursor(iconUrl("/КУРСОР-ОБТРАВОЧНАЯ-МАСКА.svg"), { size: 28 });
  const [draggingMaskLayerId, setDraggingMaskLayerId] = useState<string | null>(null);
  const [maskDropTargetId, setMaskDropTargetId] = useState<string | null>(null);
  const [layerFilter, setLayerFilter] = useState<"all" | "pixel" | "adjustment" | "text" | "shape" | "smart">("all");
  const [layerFilterOn, setLayerFilterOn] = useState(false);
  const [dropHint, setDropHint] = useState<{ overId: string; position: "above" | "into" | "below" } | null>(null);
  // The drop handler runs from a window listener, outside this render's closure.
  const dropHintRef = useRef(dropHint);
  dropHintRef.current = dropHint;
  const maskDropTargetRef = useRef(maskDropTargetId);
  maskDropTargetRef.current = maskDropTargetId;
  const contextMenu = useContextMenu();
  const selectedLayerIds = useShellStore((state) => (activeDocumentId ? state.selectedLayerIdsByDocument[activeDocumentId] : undefined) ?? EMPTY_LAYER_SELECTION);
  const setSelectedLayers = useShellStore((state) => state.setSelectedLayers);
  const editingMaskLayerId = useShellStore((state) => activeDocumentId ? state.editingMaskLayerIdByDocument[activeDocumentId] ?? null : null);
  const setEditingMask = useShellStore((state) => state.setEditingMask);
  const setScene3DOrbitLayer = useShellStore((state) => state.setScene3DOrbitLayer);
  const setScene3DGroundLayer = useShellStore((state) => state.setScene3DGroundLayer);
  const setTool = useShellStore((state) => state.setTool);
  useEffect(() => {
    const open = () => { const current = activeDocumentId ? kernel.documents.get<RasterDocumentState>(activeDocumentId) : null; if (current && isRasterDocumentState(current.state)) setStyleLayerId(current.state.activeLayerId); };
    window.addEventListener("vravio-layer-style-open", open); return () => window.removeEventListener("vravio-layer-style-open", open);
  }, [activeDocumentId]);
  // master-plan.md §1.9 item 1: clicking a mask thumbnail sets
  // `editingMaskLayerId` (see `LayerMaskThumbnail`'s `onActivate` below), but
  // nothing was listening for Delete/Backspace while it stayed set — the key
  // that removes a *layer* (`layer.delete`) has no shortcut bound at all
  // (confirmed against `catalogue.test.ts`'s snapshot), so pressing Delete
  // with a mask "selected" this way did nothing whatsoever, not "delete the
  // wrong thing". Scoped to only listen while a mask is actually being
  // edited, so it can't steal Delete from anything else (a future
  // delete-selection-contents binding on `layer.delete`, an `<input>`, etc.).
  useEffect(() => {
    if (!activeDocumentId || !editingMaskLayerId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      // Bare Delete/Backspace only — Alt+Delete/Mod+Delete are the catalogue's
      // own `edit.fillForeground`/`edit.fillBackground` (fill-shortcuts.ts),
      // bound through the kernel keymap rather than this raw listener. Both
      // listeners see the same keydown (the comment on `layer.clear` already
      // covers why this one exists at all instead of going through the
      // catalogue), so without this guard holding Alt or Mod while editing a
      // mask would punch a hole *and* fill it in the same keypress.
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      const maskLayerId = editingMaskLayerId, documentId = activeDocumentId;
      // A selection while editing a mask punches a hole in *that* mask — Photoshop
      // paints the selected area black rather than discarding the whole mask, the
      // same way Delete on a normal layer clears just the selected pixels instead
      // of removing the layer. Only Delete with nothing selected reaches for the
      // confirm-and-remove-the-whole-mask path below.
      const document = kernel.documents.get<RasterDocumentState>(documentId);
      if (document && isRasterDocumentState(document.state) && document.state.selection) {
        const selection = document.state.selection;
        void changeRasterDocument(documentId, "Clear Mask Selection (Очистить выделение на маске)", (current) => {
          const layer = current.layers.find((item) => item.id === maskLayerId);
          if (!layer || layer.kind === "group" || !layer.mask) return false;
          layer.mask.pixels = punchSelectionIntoMask(layer.mask.pixels, current.width, current.height, selection);
          return true;
        });
        return;
      }
      void (async () => {
        const confirmed = await confirmModal({
          title: text(language, "Delete Layer Mask", "Удалить маску слоя"),
          message: text(language, "Remove this layer's mask?", "Удалить маску этого слоя?"),
          confirmLabel: text(language, "Delete", "Удалить"),
          danger: true,
          confirmKey: "delete-layer-mask",
        });
        if (!confirmed) return;
        void changeRasterDocument(documentId, "Delete Layer Mask (Удалить маску слоя)", (current) => {
          const layer = current.layers.find((item) => item.id === maskLayerId);
          if (!layer || layer.kind === "group" || !layer.mask) return false;
          delete layer.mask;
          return true;
        });
        setEditingMask(documentId, null);
      })();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDocumentId, editingMaskLayerId, language, setEditingMask]);
  // The adjustment-layer list (opened by the "New adjustment layer" button)
  // was the second dropdown found with the exact §8.3 bug — closes App.tsx's
  // pair with the same shared hook rather than a third hand-rolled listener.
  // Matches `.adjustment-menu` (the open list) and `.adjustment-toggle` (the
  // button itself) specifically, not the whole `.adjustment-actions`
  // toolbar row it sits in — that row also holds unrelated buttons (link,
  // fx, clipping mask, add layer, trash), and clicking any of those should
  // close this list too, not be swallowed by a too-broad wrapper match.
  useCloseOnOutsideClick(showAdjustments, ".adjustment-menu, .adjustment-toggle", () => setShowAdjustments(false));
  const active = documents.find((document) => document.id === activeDocumentId);
  const timed = active?.kind === "audio" || active?.kind === "video";
  if (active && isRasterDocumentState(active.state)) {
    const state = active.state;
    const addLayer = () => { let createdId = ""; void changeRasterDocument(active.id, "New Layer (Новый слой)", (current) => { const selected = current.layers.find((item) => item.id === current.activeLayerId); const parentId = selected?.kind === "group" ? selected.id : (selected?.parentId ?? null); const layer = createRasterLayer(current.width, current.height, `Layer ${current.layers.length + 1} (Слой ${current.layers.length + 1})`); appendLayer(current, layer, parentId); current.activeLayerId = layer.id; createdId = layer.id; return true; }); setSelectedLayers(active.id, [createdId]); };
    const addGroup = () => { let createdId = ""; void changeRasterDocument(active.id, "New Group (Новая группа)", (current) => { const number = current.layers.filter((item) => item.kind === "group").length + 1; const group = appendRasterGroup(current, `Group ${number} (Группа ${number})`); current.activeLayerId = group.id; createdId = group.id; return true; }); setSelectedLayers(active.id, [createdId]); };
    const addAdjustment = (definition: (typeof rasterAdjustments)[number]) => { void changeRasterDocument(active.id, `New Adjustment Layer: ${definition.name.en} (Новый корректирующий слой: ${definition.name.ru})`, (current) => { const selected = current.layers.find((item) => item.id === current.activeLayerId); const layer = createAdjustmentLayer(current.width, current.height, definition.id, `${definition.name.en} (${definition.name.ru})`); appendLayer(current, layer, selected?.kind === "group" ? selected.id : (selected?.parentId ?? null)); current.activeLayerId = layer.id; return true; }); setShowAdjustments(false); };
    const deleteLayer = () => { let survivorId = "", removedMaskTarget = false; void changeRasterDocument(active.id, "Delete Layer (Удалить слой)", (current) => { const index = current.layers.findIndex((item) => item.id === current.activeLayerId); if (index < 0) return false; const target = current.layers[index]!; const removed = new Set([target.id, ...rasterLayerDescendantIds(current.layers, target.id)]); removedMaskTarget = editingMaskLayerId ? removed.has(editingMaskLayerId) : false; current.layers = current.layers.filter((item) => !removed.has(item.id)); if (!current.layers.some((item) => item.kind !== "group")) appendLayer(current, createRasterLayer(current.width, current.height, "Layer 1 (Слой 1)")); const next = current.layers[Math.min(index, current.layers.length - 1)] ?? current.layers[0]; if (!next) return false; current.activeLayerId = next.id; survivorId = next.id; return true; }); if (removedMaskTarget) setEditingMask(active.id, null); if (survivorId) setSelectedLayers(active.id, [survivorId]); };
    const selectLayer = (id: string) => kernel.documents.update<RasterDocumentState>(active.id, (current) => { current.activeLayerId = id; });

    /**
     * The layer row's right-click menu: the commands that declare the
     * `layer-context` surface, plus the entries the panel still owns itself.
     *
     * The command-backed half used to be re-typed here, and had already
     * drifted — this menu said "Объединить с нижним" where `layer.mergeDown`
     * says "Объединить с предыдущим", and greyed Ungroup out for a non-group
     * while the command claimed to be enabled. Both labels and enabled-ness
     * now come from the catalogue, so there is one answer to each.
     *
     * Delete, Group, Layer Style and Link stay here on purpose: the first two
     * do more in the panel than their commands do (see their definitions), and
     * the last two are not commands at all yet.
     */
    const layerContextMenu = (layer: RasterLayer): ContextMenuItem[] => {
      const fromCatalogue = pickCommands("layer-context", ["layer.duplicate", "layer.mergeDown", "layer.mergeVisible", "layer.ungroup", "image.adjustment.invert"], { activeDocumentId: active.id }, language);
      const byId = new Map(fromCatalogue.map((command) => [command.id, command]));
      const item = (id: string, extra?: Partial<ContextMenuItem>): ContextMenuItem => {
        const command = byId.get(id)!;
        return { label: command.label, onSelect: command.run, disabled: !command.enabled, ...extra };
      };
      return [
        item("layer.duplicate"),
        { label: text(language, "Delete Layer", "Удалить слой"), onSelect: deleteLayer, danger: true },
        { label: text(language, "Layer Style…", "Стиль слоя…"), onSelect: () => setStyleLayerId(layer.id), disabled: layer.kind === "group" },
        // Owner's own request: a text layer offers "Convert to 3D" — extrudes
        // its own opaque silhouette (convertLayerToScene3D's own doc comment
        // explains why silhouette, not TextGeometry-from-the-string: the
        // bundled 3D typeface is Latin-only, and this project is bilingual).
        // Not restricted to text specifically — nothing about the underlying
        // operation is, and offering it for any non-group layer costs nothing
        // extra to show, the same way "Экструдировать слой в 3D" already does.
        ...(layer.kind === "text" || layer.kind === "pixel" || layer.kind === "shape" ? [{ label: text(language, "Convert to 3D", "Преобразовать в 3D"), onSelect: () => void convertLayerToScene3D(active.id, layer.id) }] : []),
        // "Rotate 3D Object" opens the same Blender-style gizmo the canvas
        // menu does (RasterWorkspace.tsx) — it only renders while the Move
        // tool is active (it sits under that tool's own transform frame),
        // so choosing it from here has to switch tools too, or the click
        // would silently do nothing.
        ...(layer.kind === "3d" ? [{ label: text(language, "Rotate 3D Object", "Повернуть 3D объект"), onSelect: () => { setTool(active.id, "raster.move"); setScene3DGroundLayer(active.id, null); setScene3DOrbitLayer(active.id, layer.id); } }] : []),
        ...(layer.kind === "3d" ? [{ label: text(language, "Cast Shadow…", "Настроить тень…"), onSelect: () => { setTool(active.id, "raster.move"); setScene3DOrbitLayer(active.id, null); setScene3DGroundLayer(active.id, layer.id); } }] : []),
        ...(layer.kind === "3d" && layer.scene3d?.ground ? [{ label: text(language, "Reset Shadow Settings", "Сбросить настройки тени"), onSelect: () => void updateScene3DLayer(active.id, layer.id, { ground: { ...defaultScene3DGround } }) }] : []),
        // Harmonize moved off the right-click menu, to Изображение ▸ Коррекция ▸ Быстрая
        // гармонизация (adjustments.ts's `quickHarmonizeCommand`) — the owner's own
        // reclassification of it from a 3D-only scene tweak to a general one-shot filter any
        // layer can use, which no longer fits a menu scoped to `layer.kind === "3d"`.
        item("layer.mergeDown"),
        item("layer.mergeVisible"),
        // Owner's own request: right-clicking a layer should offer Invert directly. The command
        // itself is mask-aware (`image.adjustment.invert`'s own doc comment) — right-click already
        // makes `layer` the active layer/mask target above (`onContextMenu`'s `selectLayer` call),
        // so this inverts whichever of the layer's pixels or its mask was actually being edited.
        item("image.adjustment.invert", { separatorBefore: true }),
        { label: text(language, "Group Layers", "Сгруппировать слои"), onSelect: addGroup, separatorBefore: true },
        item("layer.ungroup"),
        { label: text(language, layer.linkGroup ? "Unlink Layers" : "Link Layers", layer.linkGroup ? "Отвязать слои" : "Связать слои"), onSelect: () => kernel.documents.update<RasterDocumentState>(active.id, (current) => { toggleLayerLink(current, selectedLayerIds.length > 1 ? selectedLayerIds : [layer.id]); }) },
        // master-plan.md §1.9 item 6, dословно: Apply/Copy/Paste Mask,
        // Copy/Paste/Apply Layer Style — six entries, one separator before
        // the group since none of the items above touch a mask or style.
        { label: text(language, "Apply Mask", "Применить маску"), onSelect: () => applyMask(layer), disabled: layer.kind === "group" || !layer.mask, separatorBefore: true },
        { label: text(language, "Copy Mask", "Скопировать маску"), onSelect: () => copyMask(layer), disabled: layer.kind === "group" || !layer.mask },
        { label: text(language, "Paste Mask", "Вставить маску"), onSelect: () => pasteMask(layer), disabled: layer.kind === "group" || !copiedLayerMask || copiedLayerMask.pixels.length !== state.width * state.height },
        { label: text(language, "Copy Layer Style", "Скопировать стиль слоя"), onSelect: () => copyLayerStyle(layer), disabled: layer.kind === "group" },
        { label: text(language, "Paste Layer Style", "Вставить стиль слоя"), onSelect: () => pasteLayerStyle(layer), disabled: layer.kind === "group" || !copiedLayerStyle },
        { label: text(language, "Apply Layer Style", "Применить стиль слоя"), onSelect: () => applyLayerStyle(layer), disabled: layer.kind === "group" || !Object.values(layer.effects ?? {}).some((effect) => effect?.enabled) },
      ];
    };
    const clickLayer = (id: string, event: React.MouseEvent) => {
      if (event.ctrlKey && clippingHoverId === id) { selectLayer(id); void kernel.commands.execute("layer.toggleClippingMask", { activeDocumentId: active.id }); return; }
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
    // master-plan.md §1.9 item 2: an active pixel selection becomes the new
    // mask's shape (white inside, black outside) instead of just vanishing —
    // Photoshop's own "Add Layer Mask with a selection active" behaviour.
    // `document.selection` is cleared afterward: the shape now lives in the
    // mask, and leaving the marching ants up over it would say two things at
    // once about what's "selected".
    const addMask = () => {
      let targetId: string | null = null, consumedSelection = false;
      // `changeRasterDocument`'s own history snapshot only carries
      // `layers`/`activeLayerId` (see its comment: layer edits and selection
      // edits are deliberately "the two ways" a raster document changes,
      // each with its own undo mechanism) — setting `current.selection` here
      // would silently vanish on commit, not persist. Clearing the selection
      // is therefore a second, separate `changeRasterSelection` call below,
      // after this one has read it into the new mask.
      void changeRasterDocument(active.id, "Add Layer Mask (Добавить маску слоя)", (current) => {
        const layer = current.layers.find((item) => item.id === current.activeLayerId);
        if (!layer || layer.kind === "group" || layer.mask) return false;
        layer.mask = current.selection ? createRasterLayerMaskFromSelection(current.selection) : createRasterLayerMask(current.width, current.height);
        consumedSelection = Boolean(current.selection);
        targetId = layer.id;
        return true;
      });
      if (consumedSelection) void changeRasterSelection(active.id, "Add Layer Mask (Добавить маску слоя)", () => null);
      if (targetId) setEditingMask(active.id, targetId);
    };
    // master-plan.md §1.9 item 9: this used to duplicate layer.toggleClippingMask's
    // own logic locally — now just calls the command, the single place that
    // decides what toggling a layer's clipping means (also reused by the
    // Ctrl-click-between-rows gesture below).
    const toggleClipping = () => void kernel.commands.execute("layer.toggleClippingMask", { activeDocumentId: active.id });

    /** The eye icon on one row of a layer's expanded fx list — hides/shows that one
     * effect without touching the others, per RasterLayerEffects' own per-effect
     * `enabled` field (already there; this is the first UI to read or write it). */
    const toggleLayerEffect = (layerId: string, key: keyof RasterLayerEffects) => void changeRasterDocument(active.id, "Toggle Layer Effect (Переключить эффект слоя)", (current) => {
      const target = current.layers.find((item) => item.id === layerId);
      const effect = target?.effects?.[key];
      if (!effect) return false;
      effect.enabled = !effect.enabled;
      return true;
    });

    /**
     * master-plan.md §19.1's P0 "Apply Mask" and §1.9 item 6's context-menu
     * entry are the same command. Bakes the mask's coverage into the
     * layer's own alpha (`alpha *= maskValue/255 * density` — the exact
     * formula the compositor already uses, `render.ts`'s `maskAlpha`) and
     * removes the mask. Layers are already always RGBA here, unlike
     * Patchy's RGB-by-default model, so there's no separate "promote to
     * RGBA first" step to port. Goes through `layerDocumentPixels` because
     * `mask.pixels` is document-sized but `layer.pixels` is trimmed to the
     * layer's own bounds (CLAUDE.md §1) — `setLayerPixels` re-trims the
     * result afterward.
     */
    const applyMask = (layer: RasterLayer) => void changeRasterDocument(active.id, "Apply Layer Mask (Применить маску слоя)", (current) => {
      const target = current.layers.find((item) => item.id === layer.id);
      if (!target || target.kind === "group" || !target.mask) return false;
      const mask = target.mask;
      const pixels = layerDocumentPixels(target, current.width, current.height).slice();
      for (let index = 0; index < mask.pixels.length; index += 1) {
        const alpha = (mask.pixels[index]! / 255) * mask.density, offset = index * 4 + 3;
        pixels[offset] = Math.round(pixels[offset]! * alpha);
      }
      setLayerPixels(target, pixels, current.width, current.height);
      delete target.mask;
      if (editingMaskLayerId === target.id) setEditingMask(active.id, null);
      return true;
    });
    const copyMask = (layer: RasterLayer) => { if (layer.mask) copiedLayerMask = { ...layer.mask, pixels: layer.mask.pixels.slice() }; };
    // Only sized masks that actually fit this document paste — a mask
    // copied from a different, differently-sized document has no sensible
    // meaning here, and silently truncating/padding its buffer would just
    // draw garbage. Refuses quietly, the same way `beginMaskDrag` (§1.9
    // item 5) refuses a drop onto a layer that already has a mask.
    const pasteMask = (layer: RasterLayer) => { const source = copiedLayerMask; if (!source || source.pixels.length !== state.width * state.height) return; void changeRasterDocument(active.id, "Paste Layer Mask (Вставить маску слоя)", (current) => { const target = current.layers.find((item) => item.id === layer.id); if (!target || target.kind === "group") return false; target.mask = { ...source, pixels: source.pixels.slice() }; return true; }); };
    const copyLayerStyle = (layer: RasterLayer) => { copiedLayerStyle = { ...layer.effects }; };
    const pasteLayerStyle = (layer: RasterLayer) => { const source = copiedLayerStyle; if (!source) return; void changeRasterDocument(active.id, "Paste Layer Style (Вставить стиль слоя)", (current) => { const target = current.layers.find((item) => item.id === layer.id); if (!target || target.kind === "group") return false; target.effects = { ...source }; return true; }); };
    /**
     * "Apply Layer Style" bakes enabled effects into the layer's own
     * pixels and clears `effects` — the same "flatten a live decoration
     * into content" shape as `applyMask` just above, reusing the exact
     * renderer the compositor itself calls for a layer with effects on
     * (`renderLayerEffects`, `render.ts`'s own `wholeCanvas` path) rather
     * than re-deriving drop-shadow/glow math a second time.
     */
    const applyLayerStyle = (layer: RasterLayer) => void changeRasterDocument(active.id, "Apply Layer Style (Применить стиль слоя)", (current) => {
      const target = current.layers.find((item) => item.id === layer.id);
      if (!target || target.kind === "group" || !Object.values(target.effects ?? {}).some((effect) => effect?.enabled)) return false;
      const documentPixels = layerDocumentPixels(target, current.width, current.height);
      const expanded: RasterLayer = { ...target, pixels: documentPixels, bounds: { x: 0, y: 0, width: current.width, height: current.height } };
      const rendered = renderLayerEffects(expanded, current.width, current.height).slice();
      setLayerPixels(target, rendered, current.width, current.height);
      target.effects = {};
      return true;
    });
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

    /**
     * master-plan.md §1.9 item 5: grabbing a mask thumbnail and dropping it
     * on another layer's row moves the mask there — Photoshop's own plain
     * drag of a mask thumbnail between layer rows. `stopPropagation` on
     * pointerdown keeps this from also starting `beginRowDrag` (whose own
     * listener sits on the same row, further up the DOM). Refuses to drop
     * onto a layer that already has a mask, a group, or itself — silently,
     * the same way `beginRowDrag` silently no-ops dropping onto its own
     * source row.
     */
    const beginMaskDrag = (layerId: string) => (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const list = (event.currentTarget as HTMLElement).closest(".layer-list");
      if (!list) return;
      const startX = event.clientX, startY = event.clientY;
      let dragging = false;

      const rowUnder = (clientX: number, clientY: number): HTMLElement | null => {
        for (const element of list.querySelectorAll<HTMLElement>(".layer-row")) {
          const box = element.getBoundingClientRect();
          if (clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom) return element;
        }
        return null;
      };

      const move = (native: PointerEvent) => {
        if (!dragging && Math.hypot(native.clientX - startX, native.clientY - startY) < 4) return;
        dragging = true;
        setDraggingMaskLayerId(layerId);
        const row = rowUnder(native.clientX, native.clientY);
        const targetId = row?.dataset.layerId;
        setMaskDropTargetId(targetId && targetId !== layerId ? targetId : null);
      };

      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        const targetId = maskDropTargetRef.current;
        setDraggingMaskLayerId(null);
        setMaskDropTargetId(null);
        if (!dragging || !targetId) return;
        void changeRasterDocument(active.id, "Move Layer Mask (Переместить маску слоя)", (current) => {
          const source = current.layers.find((item) => item.id === layerId);
          const target = current.layers.find((item) => item.id === targetId);
          if (!source?.mask || !target || target.kind === "group" || target.mask) return false;
          target.mask = source.mask;
          delete source.mask;
          return true;
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
          ["lockTransparent", iconUrl("/ПРОЗРАЧНОСТЬ.svg"), text(language, "Lock transparent pixels", "Закрепить прозрачные пиксели")],
          ["lockPixels", iconUrl("/КИСТЬ_1.svg"), text(language, "Lock image pixels", "Закрепить пиксели изображения")],
          ["lockPosition", iconUrl("/КУРСОР.svg"), text(language, "Lock position", "Закрепить положение")],
          ["locked", iconUrl("/ЗАМОК.svg"), text(language, "Lock all", "Закрепить все")],
        ] as const).map(([key, icon, title]) => (
          <button key={key} className={activeLayer[key] ? "active" : ""} title={title} aria-pressed={Boolean(activeLayer[key])}
            onClick={() => updateActive({ [key]: !activeLayer[key] } as Partial<RasterLayer>)}><img src={icon} alt=""/></button>
        ))}
      </div>
      <div className="layer-controls"><select value={activeLayer.blendMode} onChange={(event) => updateActive({ blendMode: event.target.value as RasterBlendMode })}>{blendModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select><div className="layer-controls-row"><label><span>{text(language, "Opacity", "Непрозр.")}</span><input type="number" min="0" max="100" value={Math.round(activeLayer.opacity * 100)} onChange={(event) => updateActive({ opacity: Math.max(0, Math.min(1, event.target.valueAsNumber / 100)) })}/><i>%</i></label><label><span>{text(language, "Fill", "Заливка")}</span><input type="number" min="0" max="100" value={Math.round((activeLayer.fillOpacity ?? 1) * 100)} onChange={(event) => updateActive({ fillOpacity: Math.max(0, Math.min(1, event.target.valueAsNumber / 100)) })}/><i>%</i></label></div></div>
      <div className="layer-list">{(() => { const visibleRows = rasterLayerRows(state.layers).filter(({ layer }) => !layerFilterOn || layerFilter === "all" || layer.kind === layerFilter || layer.kind === "group"); return visibleRows.flatMap(({ layer, depth }, index) => {
        // master-plan.md §1.9 items 9+14: this row can become clipped to
        // the one directly below it in the (filtered) list — Ctrl-hovering
        // its bottom edge arms that, Ctrl-clicking there commits it (see
        // clickLayer). Not offered on the last row (nothing below to clip
        // to) or on a group (clipping a group as a whole isn't Photoshop's
        // model either).
        const hasBaseBelow = layer.kind !== "group" && index < visibleRows.length - 1;
        const row = <div className={[layer.id === state.activeLayerId ? "active" : "", selectedLayerIds.includes(layer.id) ? "selected" : "", layer.kind === "group" ? "group" : "", draggingLayerId === layer.id ? "dragging" : "", clippingHoverId === layer.id ? "clipping-armed" : "", "layer-row"].filter(Boolean).join(" ")} style={{ "--layer-depth": depth, cursor: clippingHoverId === layer.id ? clippingCursor : undefined } as CSSProperties} key={layer.id} data-layer-id={layer.id} data-group={layer.kind === "group"} data-drop={dropHint?.overId === layer.id ? dropHint.position : undefined} data-mask-drop-target={maskDropTargetId === layer.id || undefined} onPointerDown={beginRowDrag(layer.id)} onContextMenu={(event) => { selectLayer(layer.id); contextMenu.open(event, layerContextMenu(layer)); }} onMouseMove={(event) => { if (!hasBaseBelow || !event.ctrlKey) { if (clippingHoverId) setClippingHoverId(null); return; } const rect = event.currentTarget.getBoundingClientRect(); const armed = event.clientY - rect.top > rect.height - 7; setClippingHoverId(armed ? layer.id : null); }} onMouseLeave={() => setClippingHoverId((current) => current === layer.id ? null : current)}><button onClick={() => toggleVisible(layer.id)} aria-label={text(language, "Toggle visibility", "Переключить видимость")}><img src={iconUrl(layer.visible ? "/ГЛАЗ ОТКРЫТ.svg" : "/ГЛАЗ ЗАКРЫТ.svg")} alt=""/></button><button onClick={(event) => clickLayer(layer.id, event)} onDoubleClick={() => { selectLayer(layer.id); if (layer.kind !== "group") setStyleLayerId(layer.id); }}><span className="layer-hierarchy-space"/>{layer.kind === "group" && <span className="layer-disclosure" onClick={(event) => { event.stopPropagation(); toggleExpanded(layer.id); }}>{layer.expanded === false ? "▸" : "▾"}</span>}{layer.clipping && <span className="layer-clip-indicator" role="button" tabIndex={0} title={text(language, "Release clipping mask", "Снять обтравочную маску")} onClick={(event) => { event.stopPropagation(); selectLayer(layer.id); toggleClipping(); }} onKeyDown={(event) => { if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); event.stopPropagation(); selectLayer(layer.id); toggleClipping(); }} style={{ "--clip-mask": `url("${iconUrl("/ОБТРАВОЧНАЯ-МАСКА-СТРЕЛКА.svg")}")` } as CSSProperties} />}<span className="layer-thumbs"><LayerThumbnail layer={layer} active={layer.id === state.activeLayerId && editingMaskLayerId !== layer.id} onActivate={() => { selectLayer(layer.id); setEditingMask(active.id, null); setSelectedLayers(active.id, [layer.id]); }}/>{layer.mask && <><span className={`mask-link-toggle${layer.mask.linked ? "" : " unlinked"}`} role="button" tabIndex={0} title={text(language, layer.mask.linked ? "Unlink mask from layer" : "Link mask to layer", layer.mask.linked ? "Отвязать маску от слоя" : "Привязать маску к слою")} onClick={(event) => { event.stopPropagation(); void changeRasterDocument(active.id, "Toggle Mask Link (Переключить связь маски)", (current) => { const target = current.layers.find((item) => item.id === layer.id); if (!target || !target.mask) return false; target.mask.linked = !target.mask.linked; return true; }); }} onKeyDown={(event) => { if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); event.stopPropagation(); void changeRasterDocument(active.id, "Toggle Mask Link (Переключить связь маски)", (current) => { const target = current.layers.find((item) => item.id === layer.id); if (!target || !target.mask) return false; target.mask.linked = !target.mask.linked; return true; }); }}><span className="mask-link-icon" style={{ "--mask-link-mask": `url("${iconUrl(layer.mask.linked ? "/МАСКА-СВЯЗАНА.svg" : "/МАСКА-НЕ-СВЯЗАНА.svg")}")` } as CSSProperties} /></span><LayerMaskThumbnail mask={layer.mask} width={state.width} height={state.height} active={editingMaskLayerId === layer.id} onActivate={() => { selectLayer(layer.id); setEditingMask(active.id, layer.id); setSelectedLayers(active.id, [layer.id]); }} onDragStart={beginMaskDrag(layer.id)}/></>}</span>{layer.colorLabel && layer.colorLabel !== "none" && <i className="layer-color-label" data-color={layer.colorLabel} aria-hidden="true"/>}<span className="layer-row-text"><b>{localized(layer.name, language)}</b><small>{layer.kind === "group" ? (layer.groupMode === "isolated" ? "isolated" : "pass through") : `${layer.blendMode} · ${Math.round(layer.opacity * 100)}%`}</small></span>{layer.kind !== "group" && configuredLayerEffects(layer).length > 0 && <span className="layer-fx-group"><button className={`layer-fx-badge${styleLayerId === layer.id ? " active" : ""}`} onClick={(event) => { event.stopPropagation(); setStyleLayerId(layer.id); }} title={text(language, "Layer style", "Стиль слоя")}>fx</button><button className="layer-fx-disclosure" onClick={(event) => { event.stopPropagation(); toggleFxExpanded(layer.id); }} aria-label={text(language, "Toggle effects list", "Развернуть список эффектов")}>{expandedFxIds.has(layer.id) ? "▾" : "▸"}</button></span>}{layer.linkGroup && layer.linkGroup === activeLayer.linkGroup && <em className="layer-badge layer-link-badge" title={text(language, "Linked", "Связан")} style={{ "--link-badge-mask": `url("${iconUrl("/МАСКА-СВЯЗАНА.svg")}")` } as CSSProperties} />}{(layer.locked || layer.lockPixels || layer.lockPosition || layer.lockTransparent) && <em className="layer-badge" title={text(language, "Locked", "Закреплён")}>🔒</em>}</button></div>; const fxChildRows = layer.kind !== "group" && expandedFxIds.has(layer.id) ? configuredLayerEffects(layer).map((entry) => <div key={`${layer.id}:${entry.key}`} className="layer-row layer-fx-row"><button onClick={() => toggleLayerEffect(layer.id, entry.key)} aria-label={text(language, "Toggle effect visibility", "Переключить видимость эффекта")}><img src={iconUrl(entry.enabled ? "/ГЛАЗ ОТКРЫТ.svg" : "/ГЛАЗ ЗАКРЫТ.svg")} alt=""/></button><span className="layer-fx-row-content"><span className="layer-row-text"><b>{entry.label.split(" (")[0]}</b></span></span></div>) : []; return [row, ...fxChildRows]; }); })()}</div>
      <div className="layer-actions adjustment-actions">{showAdjustments && adjustmentMenuAnchor && <div className="adjustment-menu" style={{ position: "fixed", left: adjustmentMenuAnchor.left, bottom: adjustmentMenuAnchor.bottom }}>{rasterAdjustments.filter((definition) => definition.supportsAdjustmentLayer).map((definition) => <button key={definition.id} onClick={() => addAdjustment(definition)}><img src={iconUrl(definition.icon)} alt="" width={16} height={16}/><span>{language === "ru" ? definition.name.ru : definition.name.en}</span></button>)}</div>}<button onClick={() => { kernel.documents.update<RasterDocumentState>(active.id, (current) => { toggleLayerLink(current, selectedLayerIds.length > 1 ? selectedLayerIds : [current.activeLayerId]); }); }} title={text(language, "Link layers", "Связать слои")}><img src={iconUrl("/СВЯЗЬ.svg")} alt=""/></button><button disabled={activeLayer.kind === "group"} onClick={() => setStyleLayerId(activeLayer.id)} title={text(language, "Layer style", "Стиль слоя")}><b className="fx-label">fx</b></button><button ref={adjustmentToggleRef} className="adjustment-toggle" onClick={() => setShowAdjustments((value) => { const next = !value; if (next) { const rect = adjustmentToggleRef.current?.getBoundingClientRect(); if (rect) setAdjustmentMenuAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 4 }); } return next; })} title={text(language, "New adjustment layer", "Новый корректирующий слой")}><img src={iconUrl("/КОРРЕКТИРУЮЩИЙ СЛОЙ.svg")} alt=""/></button><button className={activeLayer.clipping ? "active" : ""} onClick={toggleClipping} disabled={activeLayer.kind === "group"} title={text(language, "Create clipping mask", "Создать обтравочную маску")}><img src={iconUrl("/ОБТРАВОЧНАЯ МАСКА.svg")} alt=""/></button><button onClick={addMask} disabled={activeLayer.kind === "group" || Boolean(activeLayer.mask)} title={text(language, "Add layer mask", "Добавить маску слоя")}><img src={iconUrl("/МАСКА СЛОЯ.svg")} alt=""/></button><button onClick={addGroup} title={text(language, "New group", "Новая группа")}><img src={iconUrl("/ГРУППА.svg")} alt=""/></button><button onClick={addLayer} title={text(language, "New layer", "Новый слой")}><img src={iconUrl("/НОВЫЙ СЛОЙ.svg")} alt=""/></button><button data-role="trash" data-armed={dropHint?.overId === "trash" || undefined} onClick={deleteLayer} title={text(language, "Delete layer (drop a layer here)", "Удалить слой (можно перетащить сюда)")}><img src={iconUrl("/КОРЗИНА.svg")} alt=""/></button></div>
      {styleLayer && <LayerStyleDialog layer={styleLayer} onClose={() => setStyleLayerId(null)} onApply={(patch) => kernel.documents.update<RasterDocumentState>(active.id, (current) => { const target = current.layers.find((layer) => layer.id === styleLayer.id); if (target) Object.assign(target, patch); })}/>}
      {contextMenu.node}
    </div>;
  }
  if (active && isVectorDocumentState(active.state)) {
    const state = active.state;
    // Topmost-first, groups nested with their own children indented under
    // them and skipped entirely once collapsed — the tree stage 2 of
    // docs/vector-plan.md added, in place of the flat list this panel used
    // to draw straight from state.shapes (which had no nesting to show).
    const rows = vectorShapeRows(state.shapes);
    const selectShape = (id: string) => kernel.documents.update<VectorDocumentState>(active.id, (current) => { current.activeShapeId = id; current.selection = [id]; });
    // Same shift-range / ctrl-toggle convention as the raster panel's
    // clickLayer above, over this row order (a group and its children count
    // as adjacent for a shift-range the way they visually are).
    const clickShape = (id: string, event: React.MouseEvent) => {
      const order = rows.map((row) => row.shape.id);
      if (event.shiftKey && state.selection.length) {
        const anchor = state.selection[state.selection.length - 1] ?? state.activeShapeId;
        const from = order.indexOf(anchor ?? ""), to = order.indexOf(id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const range = order.slice(start, end + 1);
          kernel.documents.update<VectorDocumentState>(active.id, (current) => { current.activeShapeId = id; current.selection = range; });
          return;
        }
      }
      if (event.metaKey || event.ctrlKey) {
        kernel.documents.update<VectorDocumentState>(active.id, (current) => {
          current.selection = current.selection.includes(id) ? current.selection.filter((item) => item !== id) : [...current.selection, id];
          current.activeShapeId = id;
        });
        return;
      }
      selectShape(id);
    };
    const toggleVisible = (id: string) => void changeVectorDocument(active.id, "Toggle Visibility (Переключить видимость)", (current) => { const shape = current.shapes.find((item) => item.id === id); if (!shape) return false; updateShape<VectorShape>(current, id, { visible: !shape.visible } as Partial<VectorShape>); return true; });
    const toggleLocked = (id: string) => void changeVectorDocument(active.id, "Toggle Lock (Переключить блокировку)", (current) => { const shape = current.shapes.find((item) => item.id === id); if (!shape) return false; updateShape<VectorShape>(current, id, { locked: !shape.locked } as Partial<VectorShape>); return true; });
    const toggleExpanded = (id: string) => kernel.documents.update<VectorDocumentState>(active.id, (current) => { const shape = current.shapes.find((item) => item.id === id); if (shape?.kind === "group") shape.expanded = !shape.expanded; });
    const canGroup = state.selection.length >= 2;
    const canUngroup = state.activeShapeId ? state.shapes.find((shape) => shape.id === state.activeShapeId)?.kind === "group" : false;
    return <div className="dock-panel-body">
      <div className="layer-list">{rows.map(({ shape, depth }) => <div key={shape.id} className={["layer-row", shape.id === state.activeShapeId ? "active" : "", state.selection.includes(shape.id) ? "selected" : "", shape.kind === "group" ? "group" : ""].filter(Boolean).join(" ")} style={{ "--layer-depth": depth } as CSSProperties} onClick={(event) => clickShape(shape.id, event)} onContextMenu={(event) => { if (!state.selection.includes(shape.id)) selectShape(shape.id); contextMenu.open(event, [
        { label: text(language, "Duplicate", "Дублировать"), onSelect: () => duplicateActiveVectorShape(active.id) },
        { label: text(language, "Delete", "Удалить"), onSelect: () => deleteActiveVectorShapes(active.id), danger: true },
        { label: text(language, "Group", "Сгруппировать"), onSelect: () => groupActiveVectorShapes(active.id), separatorBefore: true, disabled: !canGroup },
        { label: text(language, "Ungroup", "Разгруппировать"), onSelect: () => ungroupActiveVectorGroup(active.id), disabled: !canUngroup },
        { label: text(language, "Bring to Front", "На передний план"), onSelect: () => reorderActiveVectorShape(active.id, "front"), separatorBefore: true },
        { label: text(language, "Bring Forward", "Переместить выше"), onSelect: () => reorderActiveVectorShape(active.id, "forward") },
        { label: text(language, "Send Backward", "Переместить ниже"), onSelect: () => reorderActiveVectorShape(active.id, "backward") },
        { label: text(language, "Send to Back", "На задний план"), onSelect: () => reorderActiveVectorShape(active.id, "back") },
      ]); }}>
        <button onClick={(event) => { event.stopPropagation(); toggleVisible(shape.id); }} aria-label={text(language, "Toggle visibility", "Переключить видимость")}><img src={iconUrl(shape.visible ? "/ГЛАЗ ОТКРЫТ.svg" : "/ГЛАЗ ЗАКРЫТ.svg")} alt=""/></button>
        <span className="layer-hierarchy-space"/>
        {shape.kind === "group" && <span className="layer-disclosure" onClick={(event) => { event.stopPropagation(); toggleExpanded(shape.id); }}>{shape.expanded ? "▾" : "▸"}</span>}
        <span className="layer-row-text"><b>{shape.name}</b><small>{shape.kind === "group" ? text(language, "Group", "Группа") : `${shape.kind} · ${Math.round(shapeBounds(shape, vectorTextMeasurer).width)}×${Math.round(shapeBounds(shape, vectorTextMeasurer).height)}`}</small></span>
        <button onClick={(event) => { event.stopPropagation(); toggleLocked(shape.id); }} aria-label={text(language, "Toggle lock", "Переключить блокировку")} className={shape.locked ? "active" : ""}>{shape.locked ? "🔒" : "🔓"}</button>
      </div>)}
        {!rows.length && <div className="empty-row">{text(language, "No shapes yet — draw one with a tool", "Пока нет фигур — нарисуйте что-нибудь инструментом")}</div>}
      </div>
      <div className="layer-actions">
        <button disabled={!canGroup} onClick={() => groupActiveVectorShapes(active.id)} title={text(language, "Group", "Сгруппировать")}><img src={iconUrl("/ГРУППА.svg")} alt=""/></button>
        <button disabled={!canUngroup} onClick={() => ungroupActiveVectorGroup(active.id)} title={text(language, "Ungroup", "Разгруппировать")}><img src={iconUrl("/ГРУППА.svg")} alt="" style={{ opacity: 0.6 }}/></button>
        <button disabled={!state.activeShapeId} onClick={() => duplicateActiveVectorShape(active.id)} title={text(language, "Duplicate", "Дублировать")}><img src={iconUrl("/ПАНЕЛЬ-СЛОИ.svg")} alt="" width={16} height={16}/></button>
        <button disabled={!state.selection.length} data-role="trash" onClick={() => deleteActiveVectorShapes(active.id)} title={text(language, "Delete shape", "Удалить фигуру")}><img src={iconUrl("/КОРЗИНА.svg")} alt=""/></button>
      </div>
      {contextMenu.node}
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

/**
 * Stage 13 of docs/vector-plan.md: symbols and instances, the same
 * "definition once, place many times" idea `AssetsPanel` names for pixels
 * but this document kind implements for real. "Create Symbol" needs 1+
 * shapes selected; "Redefine" replaces an existing symbol's content with
 * whatever is currently selected (own guard: it is a no-op with nothing
 * selected, same as `createSymbolFromActiveSelection`); "Place" adds a new
 * instance at the centre of the current viewport rather than always (0,0),
 * so a repeatedly placed symbol does not stack instances invisibly on top
 * of each other.
 */
function SymbolsPanel() {
  const documents = useDocuments();
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const language = useShellStore((state) => state.language);
  const active = documents.find((document) => document.id === activeDocumentId);
  if (!active || !isVectorDocumentState(active.state)) return <div className="dock-panel-body"><div className="empty-row">{text(language, "Open a vector document to use symbols.", "Откройте векторный документ, чтобы работать с символами.")}</div></div>;

  const state = active.state;
  const symbols = listSymbols(state);
  const hasSelection = state.selection.length > 0;
  // The document's own centre, not the current viewport's — simple and
  // predictable regardless of how far the user has panned or zoomed;
  // dragging a freshly placed instance into position is one drag either
  // way.
  const placeAt = { x: state.width / 2, y: state.height / 2 };

  return <div className="dock-panel-body">
    <button className="panel-action" disabled={!hasSelection} onClick={() => createSymbolFromActiveSelection(active.id)}>
      ＋ {text(language, "Create Symbol from Selection", "Создать символ из выделения")}
    </button>
    {symbols.length === 0
      ? <div className="empty-row">{text(language, "No symbols yet — select shapes and create one.", "Символов пока нет — выделите фигуры и создайте один.")}</div>
      : <div className="layer-list">
        {symbols.map((symbol) => <div className="layer-row" key={symbol.id}>
          <button onClick={() => placeVectorSymbolInstance(active.id, symbol.id, placeAt.x, placeAt.y)} title={text(language, "Place an instance", "Разместить экземпляр")}>
            <span>{symbol.name}</span>
          </button>
          <button
            disabled={!hasSelection}
            onClick={() => redefineSymbolFromActiveSelection(active.id, symbol.id)}
            title={text(language, "Redefine from current selection", "Переопределить из текущего выделения")}
          >{symbol.instanceCount}× ⟲</button>
        </div>)}
      </div>}
    <footer className="history-footer">
      <button
        disabled={state.shapes.find((shape) => shape.id === state.activeShapeId)?.kind !== "instance"}
        onClick={() => detachActiveVectorInstance(active.id)}
      >{text(language, "Break Link", "Разорвать связь")}</button>
    </footer>
  </div>;
}

/**
 * Stage 15 of docs/vector-plan.md: the Artboards panel — parallel to the
 * Layers panel, not a replacement for it (an artboard is metadata about
 * the canvas, never a container a shape lives inside). "Fit" both makes
 * the row's artboard active and switches the viewport to "fit" mode,
 * which `VectorWorkspace.tsx`'s own fit effect then centres on whichever
 * artboard just became active — the panel does not compute pan/zoom
 * itself. Rename is a plain `window.prompt` — real and undoable, not
 * a polished inline text field; that refinement is left for later.
 */
function ArtboardsPanel() {
  const documents = useDocuments();
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const language = useShellStore((state) => state.language);
  const setViewport = useShellStore((state) => state.setViewport);
  const active = documents.find((document) => document.id === activeDocumentId);
  if (!active || !isVectorDocumentState(active.state)) return <div className="dock-panel-body"><div className="empty-row">{text(language, "Open a vector document to use artboards.", "Откройте векторный документ, чтобы работать с монтажными областями.")}</div></div>;

  const state = active.state;
  const fit = (id: string) => {
    kernel.documents.update<VectorDocumentState>(active.id, (current) => { current.activeArtboardId = id; });
    setViewport(active.id, { mode: "fit" });
  };
  // Bleed is included by default — an artboard that has one set it because
  // its own artwork is meant to run past the trim edge, so the plain
  // "export this artboard" action already has to include that margin or
  // the setting would do nothing at export time, the same dead-checkbox
  // shape CLAUDE.md §3 rules out for a tool option.
  const exportArtboard = (artboard: { name: string; x: number; y: number; width: number; height: number; bleed: number }) => {
    const crop = { x: artboard.x - artboard.bleed, y: artboard.y - artboard.bleed, width: artboard.width + artboard.bleed * 2, height: artboard.height + artboard.bleed * 2 };
    const svg = exportVectorDocumentToSvg(state, crop, vectorTextMeasurer);
    const name = `${artboard.name.replace(/\s*\([^()]*\)\s*$/, "").trim() || "artboard"}.svg`;
    void kernel.platform.fs.saveFile({ name, mime: "image/svg+xml", data: new Blob([svg], { type: "image/svg+xml" }) });
  };
  const editBleed = (artboard: Artboard) => {
    const input = window.prompt(text(language, "Bleed (document units, 0 for none)", "Вылет под обрез (в единицах документа, 0 — без вылета)"), String(artboard.bleed));
    if (input === null) return;
    const bleed = Number(input);
    if (!Number.isFinite(bleed)) return;
    void changeVectorDocument(active.id, "Set Artboard Bleed (Вылет под обрез)", (draft) => { setArtboardBleed(draft, artboard.id, bleed); return true; });
  };

  const rearrangeAll = () => {
    const defaultCount = Math.max(1, Math.ceil(Math.sqrt(state.artboards.length)));
    const countInput = window.prompt(text(language, "Artboards per row", "Областей в ряду"), String(defaultCount));
    const count = countInput ? Math.max(1, Math.round(Number(countInput))) : NaN;
    if (!Number.isFinite(count)) return;
    const spacingInput = window.prompt(text(language, "Spacing", "Отступ между областями"), "40");
    const spacing = spacingInput ? Math.max(0, Number(spacingInput)) : NaN;
    if (!Number.isFinite(spacing)) return;
    const moveArtwork = window.confirm(text(language, "Move artwork along with each artboard?", "Переносить артворк вместе с каждой областью?"));
    void changeVectorDocument(active.id, "Rearrange All Artboards (Упорядочить все монтажные области)", (draft) => { rearrangeArtboardsGrid(draft, count, spacing, "row", moveArtwork); return true; });
  };

  return <div className="dock-panel-body">
    <div className="artboard-row">
      <button className={state.rulerMode === "artboard" ? "active" : ""} onClick={() => void changeVectorDocument(active.id, "Set Ruler Mode (Режим линеек)", (draft) => { setRulerMode(draft, draft.rulerMode === "artboard" ? "global" : "artboard"); return true; })} title={text(language, "Toggle between document-wide rulers and rulers relative to the active artboard", "Переключить линейки между всем документом и активной областью")}>
        {text(language, "Ruler:", "Линейка:")} {state.rulerMode === "artboard" ? text(language, "Artboard", "Область") : text(language, "Global", "Документ")}
      </button>
      <button onClick={() => void changeVectorDocument(active.id, "Clear Guides (Очистить направляющие)", (draft) => { clearGuides(draft); return true; })} title={text(language, "Remove every guide", "Удалить все направляющие")}>
        {text(language, "Clear Guides", "Очистить направляющие")}
      </button>
    </div>
    {/* The active artboard's own numbers, which docs/vector-plan.md stage 15
        named as a hole: "изменение размера через ручки, X/Y/W/H в панели
        свойств... не сделаны". Dragging is how a layout is found and typing is
        how it is made exact — a 1080x1080 artboard is a number, not a drag —
        and Illustrator's own Artboard options are these same four fields.
        Editing width or height keeps the top-left corner still, which is what
        the same fields do there. */}
    {(() => {
      const activeArtboard = state.artboards.find((item) => item.id === state.activeArtboardId);
      if (!activeArtboard) return null;
      const set = (patch: { x?: number; y?: number; width?: number; height?: number }) =>
        void changeVectorDocument(active.id, "Artboard Bounds (Границы монтажной области)", (draft) => {
          const artboard = draft.artboards.find((item) => item.id === activeArtboard.id);
          if (!artboard) return false;
          if (patch.x !== undefined) artboard.x = patch.x;
          if (patch.y !== undefined) artboard.y = patch.y;
          // Never zero or negative: an artboard with no area cannot be clicked,
          // and so could never be given its size back.
          if (patch.width !== undefined) artboard.width = Math.max(1, patch.width);
          if (patch.height !== undefined) artboard.height = Math.max(1, patch.height);
          return true;
        });
      return <div className="artboard-fields">
        <label>X<input type="number" value={Math.round(activeArtboard.x)} onChange={(event) => set({ x: event.target.valueAsNumber })}/></label>
        <label>Y<input type="number" value={Math.round(activeArtboard.y)} onChange={(event) => set({ y: event.target.valueAsNumber })}/></label>
        <label>W<input type="number" min={1} value={Math.round(activeArtboard.width)} onChange={(event) => set({ width: event.target.valueAsNumber })}/></label>
        <label>H<input type="number" min={1} value={Math.round(activeArtboard.height)} onChange={(event) => set({ height: event.target.valueAsNumber })}/></label>
      </div>;
    })()}
    {state.artboards.length === 0
      ? <div className="empty-row">{text(language, "No artboards yet — the document itself is the canvas.", "Монтажных областей пока нет — холст пока сам является документом.")}</div>
      : <>
        <button className="panel-action" onClick={rearrangeAll} title={text(language, "Reposition every artboard into a grid (does not change their order)", "Расставить все области в сетку (не меняет их порядок)")}>
          ⊞ {text(language, "Rearrange All", "Упорядочить все")}
        </button>
        <div className="layer-list">
          {state.artboards.map((artboard, index) => <div className="artboard-row" key={artboard.id}>
            <button className={artboard.id === state.activeArtboardId ? "active" : ""} onClick={() => fit(artboard.id)} title={text(language, "Fit in window", "Уместить в окне")}>
              <span>{artboard.name}</span>
            </button>
            <button disabled={index === 0} onClick={() => void changeVectorDocument(active.id, "Reorder Artboard (Изменить порядок монтажной области)", (draft) => { reorderArtboard(draft, artboard.id, -1); return true; })} title={text(language, "Move earlier in export order", "Сдвинуть раньше в порядке экспорта")} aria-label="Move up">↑</button>
            <button disabled={index === state.artboards.length - 1} onClick={() => void changeVectorDocument(active.id, "Reorder Artboard (Изменить порядок монтажной области)", (draft) => { reorderArtboard(draft, artboard.id, 1); return true; })} title={text(language, "Move later in export order", "Сдвинуть позже в порядке экспорта")} aria-label="Move down">↓</button>
            <button onClick={() => void changeVectorDocument(active.id, "Rename Artboard (Переименовать монтажную область)", (draft) => { const name = window.prompt(text(language, "Artboard name", "Название монтажной области"), artboard.name); if (!name?.trim()) return false; renameArtboard(draft, artboard.id, name.trim()); return true; })} title={text(language, "Rename", "Переименовать")}>✎</button>
            <button className={artboard.bleed > 0 ? "active" : ""} onClick={() => editBleed(artboard)} title={text(language, "Bleed", "Вылет под обрез") + (artboard.bleed > 0 ? ` (${artboard.bleed})` : "")}>⛶</button>
            <button onClick={() => exportArtboard(artboard)} title={text(language, "Export this artboard as SVG (includes bleed)", "Экспортировать эту область как SVG (с учётом вылета)")}>⇩</button>
            <button onClick={() => void changeVectorDocument(active.id, "Duplicate Artboard (Дублировать монтажную область)", (draft) => Boolean(duplicateArtboard(draft, artboard.id)))} title={text(language, "Duplicate", "Дублировать")}>⧉</button>
            <button onClick={() => void changeVectorDocument(active.id, "Delete Artboard (Удалить монтажную область)", (draft) => { deleteArtboard(draft, artboard.id); return true; })} title={text(language, "Delete (keeps the artwork)", "Удалить (артворк останется)")}>✕</button>
          </div>)}
        </div>
      </>}
  </div>;
}

/**
 * Docs/vector-plan.md section 8's "Плашечные цвета и палитры документа" —
 * a swatch list that lives *in the document* (`state.palette`), not
 * `ColorPickerDialog.tsx`'s own `localStorage` recent-colours list, which
 * is per-browser and never saved or loaded with a file. Rename is a plain
 * `window.prompt`, same as `ArtboardsPanel`'s own — real and undoable, not
 * a polished inline text field.
 */
function PalettePanel() {
  const documents = useDocuments();
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const language = useShellStore((state) => state.language);
  const foregroundColor = useShellStore((state) => state.foregroundColor);
  const setForegroundColor = useShellStore((state) => state.setForegroundColor);
  const iccInputRef = useRef<HTMLInputElement>(null);
  const active = documents.find((document) => document.id === activeDocumentId);
  if (!active || !isVectorDocumentState(active.state)) return <div className="dock-panel-body"><div className="empty-row">{text(language, "Open a vector document to use the palette.", "Откройте векторный документ, чтобы работать с палитрой.")}</div></div>;

  const state = active.state;
  const iccAssets = kernel.assets.list().filter((asset) => asset.meta.icc === true);
  const importIccProfile = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!(await validateIccProfile(bytes))) { window.alert(text(language, "Not a valid ICC profile.", "Это не корректный ICC-профиль.")); return; }
    const assetId = await kernel.assets.importAsset(bytes, { kind: "binary", mime: "application/vnd.iccprofile", name: file.name, meta: { icc: true } });
    void changeVectorDocument(active.id, "Assign CMYK Profile (Назначить CMYK-профиль)", (draft) => { draft.cmykProfileAssetId = assetId; return true; });
  };

  return <div className="dock-panel-body">
    {/* Stage 14 of docs/vector-plan.md: on-screen colour proof — an ICC
        profile picked here is what `useCmykSoftproof` (vector-softproof.ts)
        round-trips every solid colour through when "Softproof" is on;
        assigning one is the "attach an ICC profile" UI path that section
        8's own earlier write-up flagged as the only piece
        `kernel.assets.importAsset` didn't already give for free. */}
    <div className="appearance-section">
      <div className="appearance-section-header"><span>{text(language, "Color Proof", "Цветопроба")}</span></div>
      <select value={state.cmykProfileAssetId ?? ""} onChange={(event) => void changeVectorDocument(active.id, "Assign CMYK Profile (Назначить CMYK-профиль)", (draft) => { draft.cmykProfileAssetId = event.target.value || null; return true; })}>
        <option value="">{text(language, "No profile", "Без профиля")}</option>
        {iccAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
      </select>
      <button onClick={() => iccInputRef.current?.click()}>{text(language, "Import ICC Profile…", "Импортировать ICC-профиль…")}</button>
      <input ref={iccInputRef} type="file" accept=".icc,.icm" style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importIccProfile(file); }}/>
      <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <input type="checkbox" checked={state.softproof} disabled={!state.cmykProfileAssetId} onChange={(event) => void changeVectorDocument(active.id, "Toggle Softproof (Переключить цветопробу)", (draft) => { draft.softproof = event.target.checked; return true; })}/>
        {text(language, "Softproof", "Цветопроба на экране")}
      </label>
    </div>
    <button className="panel-action" onClick={() => void changeVectorDocument(active.id, "Add Palette Color (Добавить цвет в палитру)", (draft) => { addPaletteColor(draft, cssToColor(foregroundColor)); return true; })}>
      ＋ {text(language, "Add Current Color", "Добавить текущий цвет")}
    </button>
    {state.palette.length === 0
      ? <div className="empty-row">{text(language, "No saved colors yet.", "Сохранённых цветов пока нет.")}</div>
      : <div className="layer-list">
        {state.palette.map((entry) => <div className="artboard-row" key={entry.id}>
          <button onClick={() => setForegroundColor(colorToCss(entry.color))} title={text(language, "Set as foreground color", "Сделать основным цветом")}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "2px", background: colorToCss(entry.color), border: "1px solid var(--border)", display: "inline-block" }}/>
              {entry.name}
            </span>
          </button>
          <button onClick={() => void changeVectorDocument(active.id, "Rename Palette Color (Переименовать цвет)", (draft) => { const name = window.prompt(text(language, "Color name", "Название цвета"), entry.name); if (!name?.trim()) return false; renamePaletteColor(draft, entry.id, name.trim()); return true; })} title={text(language, "Rename", "Переименовать")}>✎</button>
          <button onClick={() => void changeVectorDocument(active.id, "Delete Palette Color (Удалить цвет)", (draft) => { removePaletteColor(draft, entry.id); return true; })} title={text(language, "Delete", "Удалить")}>✕</button>
        </div>)}
      </div>}
  </div>;
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
  scripts: ScriptsPanel,
  symbols: SymbolsPanel,
  palette: PalettePanel,
  artboards: ArtboardsPanel,
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
// Every environment's own panels, not just raster's — every id used to be
// one raster already had too (layers/history/color/properties/scripts, by
// coincidence of both environments sharing those names), which is what let
// this get away with reading only raster's list. Stage 13's "symbols" panel
// is the first vector-only id, and would otherwise silently fall back to
// the generic default icon below.
const panelIcons: Record<string, string> = Object.fromEntries(environmentsWithWindows.flatMap((kind) => windowsFor(kind)).map((panel) => [panel.id, iconUrl(panel.icon)]));
panelIcons.viewport = iconUrl("/РАДИО.svg");
function PanelTab({ api, containerApi }: IDockviewPanelHeaderProps) {
  const language = useShellStore((state) => state.language);
  const contextMenu = useContextMenu();
  useEffect(() => {
    const closePeek = (event: PointerEvent) => {
      const group = api.group;
      if (group.element.classList.contains("vravio-panel-peek") && !group.element.contains(event.target as Node)) group.element.classList.remove("vravio-panel-peek");
    };
    document.addEventListener("pointerdown", closePeek, true);
    return () => document.removeEventListener("pointerdown", closePeek, true);
  }, [api]);
  const menuItems = (): ContextMenuItem[] => {
    const panel = containerApi.getPanel(api.id);
    return [
      { label: text(language, "Float Panel", "Открепить панель"), disabled: api.location.type === "floating" || !panel, onSelect: () => { if (panel) containerApi.addFloatingGroup(panel, { width: 320, height: 420 }); } },
      { label: text(language, "Close Panel", "Закрыть панель"), separatorBefore: true, onSelect: () => api.close() },
    ];
  };
  const openCollapsedPanel = () => {
    const group = api.group;
    if (!group.api.isCollapsed() && !group.element.classList.contains("vravio-grid-rail")) return;
    // Dockview's free edge group expands permanently when a tab is clicked.
    // Re-collapse after its tab-selection handler, then present the same live
    // group as an overlay extending inward from the rail. Clicking elsewhere
    // removes only the peek class; the saved layout remains collapsed.
    requestAnimationFrame(() => {
      group.api.collapse();
      group.element.classList.add("vravio-panel-peek");
    });
  };
  return <><div className="panel-tab" title={api.title} onClick={openCollapsedPanel} onContextMenu={(event) => contextMenu.open(event, menuItems())}><i aria-hidden="true" style={{ "--panel-mask": `url("${panelIcons[api.id] ?? iconUrl("/ПАРАМЕТРЫ.svg")}")` } as CSSProperties}/><span>{api.title}</span></div>{contextMenu.node}</>;
}

function PanelHeaderActions({ api, containerApi, activePanel, group }: IDockviewHeaderActionsProps) {
  const language = useShellStore((state) => state.language);
  const [collapsed, setCollapsed] = useState(() => api.isCollapsed() || (api.location.type === "grid" && (api.getHeaderPosition() === "left" || api.getHeaderPosition() === "right") && group.width <= 150));
  const [menuOpen, setMenuOpen] = useState(false);
  const [railLabels, setRailLabels] = useState(() => localStorage.getItem(PANEL_RAIL_LABELS_KEY) === "true");
  useCloseOnOutsideClick(menuOpen, ".panel-menu-wrap", () => setMenuOpen(false));
  useEffect(() => {
    const disposable = api.onDidCollapsedChange(({ isCollapsed }) => setCollapsed(isCollapsed));
    return () => disposable.dispose();
  }, [api]);
  useEffect(() => {
    group.element.classList.toggle("vravio-grid-rail", collapsed && api.location.type === "grid");
    // Re-applies the rail's own constraint on every mount, not only inside `toggleCollapsed`
    // — a layout restored from `localStorage` (`fromJSON`) already carries a collapsed grid
    // group's serialized width, but never ran the toggle handler that pairs it with
    // `setConstraints`. Without this, a layout saved before this fix (or one that simply
    // restores collapsed) stays stuck at Dockview's 100px group floor until the user
    // happens to toggle collapse off and back on.
    if (collapsed && api.location.type === "grid") api.setConstraints({ minimumWidth: railLabels ? GRID_RAIL_LABELS_MIN_WIDTH : GRID_RAIL_MIN_WIDTH });
  }, [api, api.location.type, collapsed, group, railLabels]);
  const hideActivePanel = () => {
    const documentId = useShellStore.getState().activeDocumentId;
    const document = documentId ? kernel.documents.get(documentId) : undefined;
    if (document && activePanel) window.dispatchEvent(new CustomEvent<PanelVisibilityDetail>(PANEL_REQUEST_EVENT, { detail: { kind: document.kind, id: activePanel.id, visible: false } }));
    setMenuOpen(false);
  };
  const moveActiveToEdge = (position: "left" | "right") => {
    if (!activePanel) return;
    const id = `${position}-panels`;
    let target = containerApi.groups.find((group) => group.id === id);
    if (!target) {
      const targetApi = containerApi.addEdgeGroup(position, { id, initialSize: 280, minimumSize: 220, collapsedSize: 43, autoHide: true, autoReveal: true });
      targetApi.setHeaderPosition("top");
      target = containerApi.groups.find((group) => group.id === id);
    }
    if (target) activePanel.api.moveTo({ group: target });
    setMenuOpen(false);
  };
  const moveActiveToNewGroup = (direction: "above" | "below") => {
    const canvasGroup = containerApi.getPanel("viewport")?.api.group;
    if (!activePanel || !canvasGroup) return;
    const currentIsPanelGroup = api.location.type === "grid" && !group.panels.some((panel) => panel.id === "viewport");
    const existingPanelGroup = containerApi.groups.find((candidate) => candidate.api.location.type === "grid" && !candidate.panels.some((panel) => panel.id === "viewport"));
    const referenceGroup = currentIsPanelGroup ? group : existingPanelGroup;
    const target = referenceGroup
      ? containerApi.addGroup({ referenceGroup, direction, initialHeight: 300 })
      : containerApi.addGroup({ referenceGroup: canvasGroup, direction: "right", initialWidth: 280 });
    target.api.setHeaderPosition("top");
    activePanel.api.moveTo({ group: target });
    if (referenceGroup) target.api.setSize({ height: 300 }); else target.api.setSize({ width: 280 });
    setMenuOpen(false);
  };
  const toggleRailLabels = () => {
    const next = !railLabels;
    setRailLabels(next);
    localStorage.setItem(PANEL_RAIL_LABELS_KEY, String(next));
    if (api.location.type === "grid" && collapsed) {
      api.setConstraints({ minimumWidth: next ? GRID_RAIL_LABELS_MIN_WIDTH : GRID_RAIL_MIN_WIDTH });
      api.setSize({ width: next ? GRID_RAIL_LABELS_MIN_WIDTH : GRID_RAIL_MIN_WIDTH });
    }
    window.dispatchEvent(new CustomEvent<boolean>(PANEL_RAIL_LABELS_EVENT, { detail: next }));
  };
  const toggleCollapsed = () => {
    if (api.location.type === "grid") {
      group.element.classList.remove("vravio-panel-peek");
      if (collapsed) {
        group.element.classList.remove("vravio-grid-rail");
        api.setHeaderPosition("top");
        api.setConstraints({ minimumWidth: GRID_EXPANDED_MIN_WIDTH });
        api.setSize({ width: 280 });
        setCollapsed(false);
      } else {
        group.element.classList.add("vravio-grid-rail");
        api.setHeaderPosition("right");
        const railWidth = railLabels ? GRID_RAIL_LABELS_MIN_WIDTH : GRID_RAIL_MIN_WIDTH;
        requestAnimationFrame(() => { api.setConstraints({ minimumWidth: railWidth }); api.setSize({ width: railWidth }); });
        setCollapsed(true);
      }
      return;
    }
    if (api.location.type !== "edge") return;
    if (collapsed) {
      group.element.classList.remove("vravio-panel-peek");
      api.expand();
      api.setHeaderPosition("top");
      setCollapsed(false);
      return;
    }
    // Dockview measures a left/right edge's collapsed width from the tab
    // strip. The expanded Photoshop-style group uses a top tab strip, whose
    // width is the whole panel; collapsing it directly therefore measured
    // ~280px and changed only the writing direction. Rotate the strip first,
    // let ResizeObserver see its compact cross-axis, then collapse.
    api.setHeaderPosition(api.location.position);
    requestAnimationFrame(() => { api.collapse(); setCollapsed(true); });
  };
  // Order matches the Photoshop reference (информация.txt point 2): the collapse chevron
  // (>>) sits directly after the tab strip, then a divider, then the panel's own ☰ menu —
  // not menu-before-chevron as this rendered previously.
  return <div className="panel-header-actions">
    {collapsed && <button className="panel-rail-labels" onClick={toggleRailLabels} title={railLabels ? text(language, "Icons only", "Только значки") : text(language, "Icons and names", "Значки и названия")} aria-label={railLabels ? text(language, "Show icons only", "Показать только значки") : text(language, "Show icons and names", "Показать значки и названия")}><i aria-hidden="true" style={{ "--panel-rail-mask": `url("${iconUrl(railLabels ? "/ПАНЕЛИ-БЕЗ-ПОДПИСЕЙ.svg" : "/ПАНЕЛИ-С-ПОДПИСЯМИ.svg")}")` } as CSSProperties}/></button>}
    {(api.location.type === "edge" || api.location.type === "grid") && <button className="panel-collapse" onClick={toggleCollapsed} title={collapsed ? text(language, "Expand panels", "Развернуть панели") : text(language, "Collapse to icons", "Свернуть в значки")} aria-label={collapsed ? text(language, "Expand panels", "Развернуть панели") : text(language, "Collapse panels", "Свернуть панели")}><i aria-hidden="true" style={{ "--panel-collapse-mask": `url("${iconUrl(collapsed ? "/РАЗВЕРНУТЬ-ПАНЕЛИ.svg" : "/СВЕРНУТЬ-ПАНЕЛИ.svg")}")` } as CSSProperties}/></button>}
    {!collapsed && <span className="panel-header-divider" aria-hidden="true"/>}
    {!collapsed && <div className="panel-menu-wrap">
      <button className="panel-menu-trigger" onClick={() => setMenuOpen((value) => !value)} title={text(language, "Panel menu", "Меню панели")} aria-label={text(language, "Panel menu", "Меню панели")} aria-expanded={menuOpen}><i aria-hidden="true" style={{ "--panel-menu-mask": `url("${iconUrl("/МЕНЮ-ПАНЕЛИ.svg")}")` } as CSSProperties}/></button>
      {menuOpen && <div className="panel-menu" role="menu">
        <strong>{activePanel?.title ?? text(language, "Panel", "Панель")}</strong>
        {activePanel?.api.location.type !== "floating" && <button role="menuitem" onClick={() => { if (activePanel) containerApi.addFloatingGroup(activePanel, { width: 320, height: 420 }); setMenuOpen(false); }}>{text(language, "Float panel", "Открепить панель")}</button>}
        <button role="menuitem" onClick={() => moveActiveToNewGroup("below")}>{text(language, "Move to New Group Below", "Перенести в новую группу снизу")}</button>
        <button role="menuitem" onClick={() => moveActiveToNewGroup("above")}>{text(language, "Move to New Group Above", "Перенести в новую группу сверху")}</button>
        <button role="menuitem" disabled={api.location.type === "edge" && api.location.position === "left"} onClick={() => moveActiveToEdge("left")}>{text(language, "Dock Left", "Закрепить слева")}</button>
        <button role="menuitem" disabled={api.location.type === "edge" && api.location.position === "right"} onClick={() => moveActiveToEdge("right")}>{text(language, "Dock Right", "Закрепить справа")}</button>
        {api.location.type === "edge" && <button role="menuitem" onClick={() => { api.setAutoHide(!api.isAutoHide()); setMenuOpen(false); }}>{api.isAutoHide() ? text(language, "Keep dock open", "Закрепить dock") : text(language, "Auto-hide dock", "Автоскрытие dock")}</button>}
        {activePanel && <button role="menuitem" onClick={hideActivePanel}>{text(language, "Hide panel", "Скрыть панель")}</button>}
      </div>}
    </div>}
  </div>;
}

/**
 * The global invariant: `right-panels` never sits on screen holding zero panels. Every code path
 * that can leave it empty — a preset whose panel list is `[]` (`workspace-presets.ts`), a
 * restored layout saved before that preset bug was fixed, the user closing the group's last tab
 * via its own × or the Window menu — funnels through here rather than each carrying its own
 * "is it empty now" check. Called once after `onReady` builds or restores a layout, and on every
 * `onDidLayoutChange` after that, so no future call site that mutates this group can reintroduce
 * the bug by forgetting its own cleanup.
 */
function removeEmptySideGroup(api: DockviewReadyEvent["api"]): void {
  const sideGroup = api.getGroup("right-panels");
  if (sideGroup && sideGroup.panels.length === 0) api.removeGroup(sideGroup);
}

function createDefaultLayout(api: DockviewReadyEvent["api"], language: Language, kind: EnvironmentKind, panelIds: readonly string[]): void {
  const viewportGroup = api.addGroup({ direction: "left", hideHeader: true });
  api.addPanel({ id: "viewport", component: "viewport", title: text(language, "Canvas", "Холст"), position: { referenceGroup: viewportGroup, direction: "within" } });
  // The main panel column must be a real grid group. An edge group is useful
  // for a compact wall rail, but Dockview deliberately does not split one
  // vertically, which made it impossible to drag Layers below Properties.
  // Grid groups retain native Photoshop-like tab grouping and can be split
  // above/below by both drag-and-drop and the panel menu.
  // Skip the side group entirely when nothing would go in it — creating it first and hoping a
  // later cleanup pass notices it's empty (`onDidLayoutChange`'s own check, below) is a real
  // fallback for a layout that *becomes* empty after the fact (the user closing a panel), but for
  // the very first layout of a session it left an empty docked group sitting at its full stored
  // width, found live on both Audio and Video's default preset before its own panel list bug was
  // fixed (`workspace-presets.ts`) — no group ever created here means nothing to clean up later.
  const visible = new Set(panelIds);
  const initialPanels = windowsFor(kind).filter((panel) => visible.has(panel.id));
  if (initialPanels.length === 0) return;
  const sideGroup = api.addGroup({ id: "right-panels", referenceGroup: viewportGroup, direction: "right", initialWidth: 280 });
  sideGroup.api.setHeaderPosition("top");
  for (const panel of initialPanels) api.addPanel({ id: panel.id, component: panel.component, title: windowTitle(panel, language), position: { referenceGroup: sideGroup.id, direction: "within" } });
}

export function DockLayout() {
  const language = useShellStore((state) => state.language);
  const documents = useDocuments();
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const kind = documents.find((document) => document.id === activeDocumentId)?.kind ?? "raster";
  const apiRef = useRef<DockviewReadyEvent["api"] | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [railLabels, setRailLabels] = useState(() => localStorage.getItem(PANEL_RAIL_LABELS_KEY) === "true");
  // Each preset is a real workspace, not merely a filtered view of one
  // shared layout. Keeping its serialised dock separately lets a user tune
  // Painting without unexpectedly overwriting their Essentials arrangement.
  const [workspaceId, setWorkspaceId] = useState(() => selectedWorkspacePreset(kind));
  useEffect(() => { setWorkspaceId(selectedWorkspacePreset(kind)); }, [kind]);
  useEffect(() => {
    const handle = (raw: Event) => setRailLabels((raw as CustomEvent<boolean>).detail);
    window.addEventListener(PANEL_RAIL_LABELS_EVENT, handle);
    return () => window.removeEventListener(PANEL_RAIL_LABELS_EVENT, handle);
  }, []);
  useEffect(() => {
    const handle = (raw: Event) => {
      const detail = (raw as CustomEvent<WorkspacePresetDetail>).detail;
      if (detail.kind !== kind) return;
      // Re-mounting the Dockview host is the library-supported transactional
      // reset. Calling `api.clear()` and adding panels during its disposal
      // cycle races its internal group teardown and can erase fresh panels.
      // Reset deletes only the selected preset's saved layout. Choosing a
      // different preset must retain its independently customised dock.
      if (detail.reset) localStorage.removeItem(`${LAYOUT_STORAGE_KEY}.${kind}.${detail.presetId}`);
      setWorkspaceId(detail.presetId);
      setLayoutRevision((value) => value + 1);
    };
    window.addEventListener(WORKSPACE_PRESET_EVENT, handle);
    return () => window.removeEventListener(WORKSPACE_PRESET_EVENT, handle);
  }, [kind]);
  useEffect(() => {
    // One handler, not one per environment: these two were byte-identical
    // apart from which of the duplicated registries they looked the panel up
    // in, and the event now carries the environment it belongs to.
    const handle = (raw: Event) => {
      const { kind, id, visible } = (raw as CustomEvent<PanelVisibilityDetail>).detail;
      const api = apiRef.current, definition = windowById(kind, id);
      if (!api || !definition) return;
      const existing = api.getPanel(definition.id);
      if (!visible && existing) { api.removePanel(existing); return; }
      if (visible && !existing) {
        let groupId = api.getGroup("right-panels")?.id;
        if (!groupId) {
          const viewportGroup = api.getPanel("viewport")?.api.group;
          if (!viewportGroup) return;
          const group = api.addGroup({ id: "right-panels", referenceGroup: viewportGroup, direction: "right", initialWidth: 280 });
          group.api.setHeaderPosition("top");
          groupId = group.id;
        }
        api.addPanel({ id: definition.id, component: definition.component, title: windowTitle(definition, language), position: { referenceGroup: groupId, direction: "within" } });
      }
    };
    window.addEventListener(PANEL_REQUEST_EVENT, handle);
    return () => { window.removeEventListener(PANEL_REQUEST_EVENT, handle); };
  }, [language]);
  useEffect(() => {
    const handle = (raw: Event) => {
      const enabled = (raw as CustomEvent<boolean>).detail;
      const group = apiRef.current?.getGroup("right-panels");
      if (!group) return;
      // Dockview exposes an HTMLElement on live groups at runtime, but its
      // public `getGroup` return type deliberately omits it. Keep that one
      // bridge here instead of weakening every caller of the dock API.
      const groupElement = (group as unknown as { element?: HTMLElement }).element;
      groupElement?.classList.remove("vravio-panel-peek");
      if (group.api.location.type === "edge") {
        if (enabled) group.api.collapse(); else group.api.expand();
        return;
      }
      if (enabled) {
        groupElement?.classList.add("vravio-grid-rail");
        group.api.setHeaderPosition("right");
        const railWidth = localStorage.getItem(PANEL_RAIL_LABELS_KEY) === "true" ? GRID_RAIL_LABELS_MIN_WIDTH : GRID_RAIL_MIN_WIDTH;
        group.api.setConstraints({ minimumWidth: railWidth });
        group.api.setSize({ width: railWidth });
      } else {
        groupElement?.classList.remove("vravio-grid-rail");
        group.api.setHeaderPosition("top");
        group.api.setConstraints({ minimumWidth: GRID_EXPANDED_MIN_WIDTH });
        group.api.setSize({ width: 280 });
      }
    };
    window.addEventListener(CLEAN_CANVAS_EVENT, handle);
    return () => window.removeEventListener(CLEAN_CANVAS_EVENT, handle);
  }, []);
  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    const storageKey = `${LAYOUT_STORAGE_KEY}.${kind}.${workspaceId}`;
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
    if (!restored) {
      const preset = workspacePresetById(kind, selectedWorkspacePreset(kind));
      createDefaultLayout(event.api, language, kind, preset?.panels ?? [...readVisiblePanelIds(kind)]);
    }
    else {
      // A restored layout's panels carry whatever title was serialized the last time this
      // ran — a catalogue rename (definitions/*.ts's own `title`) never reaches an already-
      // saved layout otherwise, the same "saved order disagrees with a catalogue that moved
      // on" problem CLAUDE.md documents for panel groups and toolbar order. Panel *presence*
      // already gets reconciled against the live catalogue elsewhere (readVisiblePanelIds/
      // persistVisiblePanelIds); titles did not, so this brings them into line too.
      if (kind) for (const panel of event.api.panels) { const definition = windowById(kind, panel.id); if (definition) panel.api.setTitle(windowTitle(definition, language)); }
      // Panel *presence* was believed reconciled elsewhere (readVisiblePanelIds), and was not:
      // that function only feeds `createDefaultLayout`, the `!restored` branch above — a
      // *restored* layout trusts fromJSON's panel list completely, so a panel the catalogue
      // gained after this layout was last saved (a new definitions/*.ts file, same as a brand
      // new environment gaining its first Inspector) never actually appears, no matter what
      // readVisiblePanelIds computes. Found live: `environments/audio/windows/definitions/
      // properties.ts` existed, `readVisiblePanelIds("audio")` correctly returned it, and the
      // panel still never rendered until this loop existed. Same add-a-panel call the
      // `PANEL_REQUEST_EVENT` handler below already uses for the same reason.
      const existingIds = new Set(event.api.panels.map((panel) => panel.id));
      for (const id of readVisiblePanelIds(kind)) {
        if (existingIds.has(id)) continue;
        const definition = windowById(kind, id);
        if (!definition) continue;
        let groupId = event.api.getGroup("right-panels")?.id;
        if (!groupId) {
          const viewportGroup = event.api.getPanel("viewport")?.api.group;
          if (!viewportGroup) continue;
          const group = event.api.addGroup({ id: "right-panels", referenceGroup: viewportGroup, direction: "right", initialWidth: 280 });
          group.api.setHeaderPosition("top");
          groupId = group.id;
        }
        event.api.addPanel({ id: definition.id, component: definition.component, title: windowTitle(definition, language), position: { referenceGroup: groupId, direction: "within" } });
      }
      // Layouts saved by the earlier implementation can contain an expanded
      // edge group with a left/right header. That produces the vertical text
      // the Photoshop references explicitly avoid. Normalise the header from
      // the group's actual persisted state: horizontal when pinned open,
      // vertical only for the compact rail where our tab renderer suppresses
      // or horizontally lays out the label.
      for (const group of event.api.groups) if (group.api.location.type === "edge") group.api.setHeaderPosition(group.api.isCollapsed() ? group.api.location.position : "top");
      // A layout saved before a panel's own `defaultVisible` changed (History, found live
      // claiming half the screen with nothing in it) — or before `workspace-presets.ts`'s empty
      // panel lists were fixed — can restore with `right-panels` already empty. The
      // reconciliation loop above only *adds* newly-catalogued panels, it never had a reason to
      // remove a group nothing populated; `removeEmptySideGroup` is the global invariant's own
      // one-time catch-up for whatever a stale save already left behind, the same check
      // `onDidLayoutChange` below enforces on every later change.
      removeEmptySideGroup(event.api);
    }
    event.api.onDidLayoutChange(() => {
      removeEmptySideGroup(event.api);
      localStorage.setItem(storageKey, JSON.stringify(event.api.toJSON()));
      // Only the environment the dock is actually showing. Filtering the open
      // panels by "does this environment have a panel with that id" looks
      // equivalent and is not: raster and vector both name a panel
      // `properties`, `layers`, `history` and `color`, so a vector document's
      // four panels matched raster's catalogue too and were written over
      // raster's list — turning off vector's Colour panel silently deleted the
      // raster one. Which environment the dock belongs to is a fact about the
      // active document, not something to infer from ids that collide.
      persistVisiblePanelIds(kind, event.api.panels.map((panel) => panel.id).filter((id) => windowById(kind, id)));
    });
  }, [kind, language, workspaceId]);

  // No `dndCompass` prop: that option only does anything once the (paid, unlicensed here)
  // `dockview-enterprise` package registers the `DndCompass` module — passing it anyway is a
  // checkbox that does nothing, and Dockview says so on every load ("`dndCompass` requires the
  // 'DndCompass' module"). Drag-to-split/dock/group still works through Dockview's own default
  // resolver without it; only the five-zone hover overlay is the enterprise-only piece missing.
  return <div className="dock-host" data-panel-rail-labels={railLabels}><DockviewReact key={`${language}.${kind}.${workspaceId}.${layoutRevision}`} theme={themeDark} floatingGroupBounds="boundedWithinViewport" floatingGroupDragHandle="titlebar" components={components} defaultTabComponent={PanelTab} rightHeaderActionsComponent={PanelHeaderActions} onReady={onReady} /></div>;
}
