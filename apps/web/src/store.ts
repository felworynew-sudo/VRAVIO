import { HistoryManager, type EnvironmentKind } from "@vravio/kernel";
import { createRasterDocument } from "@vravio/env-raster";
import { createArtboard, createVectorDocument } from "@vravio/env-vector";
import { createAudioDocument } from "@vravio/env-audio";
import { createVideoDocument } from "@vravio/env-video";
import { create } from "zustand";
import { kernel } from "./kernel";
import { defaultTool, toolById } from "./tools";
import { openModal } from "./modals/runtime";

export type Theme = "dark" | "light" | "contrast" | "ps-dark";
export interface InterfacePalette {
  background: string;
  surface: string;
  raisedSurface: string;
  hoverSurface: string;
  border: string;
  text: string;
  mutedText: string;
  success: string;
  warning: string;
  danger: string;
}
export type Language = "en" | "ru" | "uk" | "es" | "de" | "ja" | "zh";
export type RendererPreference = "auto" | "webgpu" | "webgl2" | "canvas2d";
export type ViewportMode = "fit" | "actual" | "custom";

export interface DocumentViewport {
  zoom: number;
  rotation: number;
  panX: number;
  panY: number;
  mode: ViewportMode;
}

export const defaultViewport: DocumentViewport = { zoom: 1, rotation: 0, panX: 0, panY: 0, mode: "fit" };

export interface NewDocumentOptions {
  name?: string;
  width: number;
  height: number;
  resolution: number;
  resolutionUnit: "ppi" | "ppcm";
  backgroundColor: string | null;
  pixelAspectRatio: number;
  artboards?: boolean;
  frameRate?: number;
  sampleRate?: number;
  channels?: number;
  audioBitDepth?: number;
}

export interface ShellPreferences {
  renderer: RendererPreference;
  memoryBudgetMb: number;
  workerCount: number;
  showPerformanceOverlay: boolean;
  dragZoom: boolean;
  showTooltips: boolean;
  contextualBar: boolean;
  /** The command palette is always available via Ctrl+K; this only controls
   * its optional button in the application bar. */
  showCommandPaletteButton: boolean;
  snapToGuides: boolean;
  smartGuides: boolean;
  /** Grid snapping is its own on/off + spacing, separate from smartGuides —
   * "align to other objects" and "align to a fixed grid" are different
   * questions a user answers independently in every editor that has both. */
  snapToGrid: boolean;
  snapGridSize: number;
  /** How close (in screen pixels, not document units — the same reason
   * `VectorWorkspace.tsx`'s own radius conversion lives where it does: only
   * the caller knows the current zoom) a drag has to land to a candidate
   * line before it snaps at all. Was a hardcoded `8` in VectorWorkspace.tsx;
   * now a real setting so "the magnetism is too aggressive" has an answer
   * that isn't "edit the source." */
  snapSensitivity: number;
  showRulers: boolean;
  showGuides: boolean;
  /** A soft glow just inside the selection edge, drawn under the marching ants.
   * On by default: the owner asked for it as a trait of this editor's ants
   * rather than an extra, and it points inward on purpose — the edge then says
   * which side of it is selected, which plain ants never do. Kept a setting all
   * the same, so anyone who wants Photoshop exactly can have it. Its width is a
   * screen measurement and never grows with the document zoom (master-plan.md
   * §1.8 makes that an explicit condition). */
  selectionGlow: boolean;
  guideColor: string;
  canvasSurround: string;
  focusColor: string;
  rasterColor: string;
  vectorColor: string;
  audioColor: string;
  videoColor: string;
  /** A complete neutral UI palette. It is only applied after the user edits a
   * color; until then the selected built-in theme remains intact. */
  interfacePalette: InterfacePalette;
  useCustomInterfacePalette: boolean;
  /**
   * "Don't ask again" for a `confirmModal` call, keyed by that call's own `key`
   * (e.g. `"delete-layer-mask"`) — `false` means skip asking and auto-confirm,
   * absent/`true` means ask normally. One shared record, not a separate boolean
   * threaded through each caller: every confirmation this project adds reads
   * and writes the same place, and Settings can list and re-enable any of them
   * from that one place too (master-plan.md §1.9 item 12's own reasoning).
   */
  confirmPreferences: Record<string, boolean>;
}

const detectedConcurrency = typeof navigator === "undefined" || !navigator.hardwareConcurrency ? 4 : navigator.hardwareConcurrency;

export const interfacePaletteForTheme = (theme: Theme): InterfacePalette => {
  if (theme === "light") return { background: "#e8eaf0", surface: "#f8f9fb", raisedSurface: "#ffffff", hoverSurface: "#e0e3eb", border: "#c5cad5", text: "#1a1d24", mutedText: "#626a78", success: "#267b53", warning: "#a86a15", danger: "#c0392b" };
  if (theme === "contrast") return { background: "#000000", surface: "#000000", raisedSurface: "#090909", hoverSurface: "#111111", border: "#ffffff", text: "#ffffff", mutedText: "#dddddd", success: "#7ee3a4", warning: "#ffff00", danger: "#ff0000" };
  /* Adobe Photoshop's Dark UI is deliberately neutral (not blue-black): the
     familiar #323232 panels, #535353 active controls and quiet grey dividers
     let the image rather than the chrome carry the colour. */
  if (theme === "ps-dark") return { background: "#1e1e1e", surface: "#323232", raisedSurface: "#3e3e3e", hoverSurface: "#535353", border: "#5a5a5a", text: "#f0f0f0", mutedText: "#b6b6b6", success: "#8ccc9b", warning: "#e0ad45", danger: "#e06c6c" };
  return { background: "#111318", surface: "#191c22", raisedSurface: "#20242c", hoverSurface: "#2a303a", border: "#323844", text: "#eef1f6", mutedText: "#929baa", success: "#78c995", warning: "#e0a13a", danger: "#d86161" };
};

const defaultPreferences: ShellPreferences = {
  renderer: "auto", memoryBudgetMb: 1024, workerCount: Math.max(1, Math.min(8, detectedConcurrency - 1)),
  dragZoom: true, showTooltips: true, contextualBar: true, showCommandPaletteButton: true, showPerformanceOverlay: false, snapToGuides: true, smartGuides: true, snapToGrid: false, snapGridSize: 20, snapSensitivity: 8, showRulers: false, showGuides: true, selectionGlow: true,
  guideColor: "#00a8ff", canvasSurround: "#2b2f36", focusColor: "#84a8ff",
  rasterColor: "#a100ff", vectorColor: "#0068ff", audioColor: "#ffb600", videoColor: "#ff0000",
  interfacePalette: interfacePaletteForTheme("dark"), useCustomInterfacePalette: false, confirmPreferences: {},
};

function readPreference<T extends string>(key: string, values: readonly T[], fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  const value = localStorage.getItem(key) as T | null;
  return value && values.includes(value) ? value : fallback;
}

function savePreference(key: string, value: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
}

function readPreferences(): ShellPreferences {
  if (typeof localStorage === "undefined") return { ...defaultPreferences };
  try { return { ...defaultPreferences, ...JSON.parse(localStorage.getItem("vravio.preferences") ?? "{}") as Partial<ShellPreferences> }; }
  catch { return { ...defaultPreferences }; }
}

interface ShellState {
  documentIds: string[];
  activeDocumentId: string | null;
  mruOrder: string[];
  activeToolByDocument: Record<string, string>;
  selectedLayerIdsByDocument: Record<string, string[]>;
  editingMaskLayerIdByDocument: Record<string, string | null>;
  /** Which 3D layer, if any, currently shows the Blender-style rotation gizmo instead of its
   * ordinary Move-tool frame — entered via "Rotate 3D Object" on the layer's own context menu
   * (RasterWorkspace.tsx's canvas menu and DockLayout.tsx's Layers-panel menu both set this;
   * the gizmo itself renders from RasterWorkspace.tsx, a different component tree than the panel
   * the menu can live in, the same cross-tree reason `editingMaskLayerIdByDocument` exists). */
  scene3dOrbitLayerIdByDocument: Record<string, string | null>;
  /** Same idea, for "Cast Shadow" — which 3D layer, if any, currently shows the ground-plane
   * tilt/distance sliders (Scene3DGroundGizmo.tsx). A separate field rather than reusing the
   * orbit one: the two are different modes on the same layer and only one should show at a time,
   * but "rotate, then also configure the shadow without losing either's own state" is a real
   * sequence a document could be in mid-session. */
  scene3dGroundLayerIdByDocument: Record<string, string | null>;
  maskForegroundIsWhiteByDocument: Record<string, boolean>;
  viewports: Record<string, DocumentViewport>;
  foregroundColor: string;
  backgroundColor: string;
  toolOptions: Record<string, Record<string, string | number | boolean>>;
  paletteOpen: boolean;
  /** Marching ants hidden with Cmd/Ctrl+H; the selection itself is untouched. */
  selectionEdgesHidden: boolean;
  settingsOpen: boolean;
  theme: Theme;
  language: Language;
  preferences: ShellPreferences;
  openDocument(kind: EnvironmentKind, options?: NewDocumentOptions): void;
  adoptRestoredDocuments(documentIds: readonly string[]): void;
  /** Give a tab to a document the kernel created, such as a round-trip child. */
  adoptDocument(id: string): void;
  requestNewDocument(kind: EnvironmentKind): void;
  /** Leaves all open documents intact and returns to the non-document home. */
  showHome(): void;
  activateDocument(id: string): void;
  closeDocument(id: string): void;
  setTool(documentId: string, toolId: string): void;
  setSelectedLayers(documentId: string, layerIds: string[]): void;
  setEditingMask(documentId: string, layerId: string | null): void;
  setScene3DOrbitLayer(documentId: string, layerId: string | null): void;
  setScene3DGroundLayer(documentId: string, layerId: string | null): void;
  setMaskForegroundWhite(documentId: string, white: boolean): void;
  swapMaskColors(documentId: string): void;
  setToolOption(toolId: string, optionId: string, value: string | number | boolean): void;
  setViewport(documentId: string, patch: Partial<DocumentViewport>): void;
  setForegroundColor(color: string): void;
  setBackgroundColor(color: string): void;
  swapColors(): void;
  resetColors(): void;
  setPaletteOpen(open: boolean): void;
  toggleSelectionEdges(): void;
  setSettingsOpen(open: boolean): void;
  setTheme(theme: Theme): void;
  setLanguage(language: Language): void;
  updatePreferences(patch: Partial<ShellPreferences>): void;
  resetAppearance(): void;
  cycleTheme(): void;
}

const names: Record<EnvironmentKind, string> = {
  raster: "Raster composition (Растровая композиция)",
  vector: "Vector artwork (Векторный рисунок)",
  audio: "Audio session (Аудиосессия)",
  video: "Video project (Видеопроект)",
};
// Pixel steps keep their buffers as asset revisions, so they weigh nothing on
// the heap and the memory budget alone would never bound undo depth: two
// hundred strokes on a 1920x1080 layer are 1.6 GB of scratch storage. The
// budget the user set is what the application may spend on derived state, so
// it caps both places that state can sit.
const createHistory = (memoryBudgetMb: number) => {
  const bytes = Math.max(64, memoryBudgetMb) * 1024 * 1024;
  return new HistoryManager({ memoryLimitBytes: bytes, storageLimitBytes: bytes });
};

export const useShellStore = create<ShellState>((set) => ({
  documentIds: [], activeDocumentId: null, mruOrder: [], activeToolByDocument: {}, selectedLayerIdsByDocument: {}, editingMaskLayerIdByDocument: {}, maskForegroundIsWhiteByDocument: {}, scene3dOrbitLayerIdByDocument: {}, scene3dGroundLayerIdByDocument: {}, viewports: {}, foregroundColor: "#000000", backgroundColor: "#ffffff", toolOptions: {}, paletteOpen: false, selectionEdgesHidden: false, settingsOpen: false,
  theme: readPreference("vravio.theme", ["dark", "light", "contrast", "ps-dark"] as const, "dark"),
  language: readPreference("vravio.language", ["en", "ru", "uk", "es", "de", "ja", "zh"] as const, "ru"),
  preferences: readPreferences(),
  openDocument: (kind, options) => set((state) => {
    const initialState = kind === "raster"
      ? createRasterDocument(options?.width, options?.height, options ? { resolution: options.resolution, resolutionUnit: options.resolutionUnit, backgroundColor: options.backgroundColor, pixelAspectRatio: options.pixelAspectRatio } : {})
      : kind === "vector"
      ? (() => {
          // The New Document dialog's "artboards" toggle is a boolean
          // ("include artboards or not"), but the document itself now holds
          // a list of them (docs/vector-plan.md §7.1) rather than a boolean
          // flag — a document with artboards enabled starts with one, sized
          // to the canvas, the same way Illustrator's own New Document
          // dialog seeds the first artboard from the size you just chose.
          const vectorState = createVectorDocument(options?.width, options?.height);
          if (options?.artboards) vectorState.artboards.push(createArtboard(0, 0, vectorState.width, vectorState.height));
          return vectorState;
        })()
      : kind === "audio"
      ? createAudioDocument({ sampleRate: options?.sampleRate ?? 48000, channels: options?.channels === 1 ? 1 : 2, bitDepth: (options?.audioBitDepth === 16 || options?.audioBitDepth === 32 ? options.audioBitDepth : 24) })
      : createVideoDocument({ frameRate: options?.frameRate ?? 30, ...(options?.width !== undefined ? { width: options.width } : {}), ...(options?.height !== undefined ? { height: options.height } : {}) });
    const document = kernel.documents.create(kind, options?.name?.trim() || names[kind], initialState);
    kernel.historyByDocument.set(document.id, createHistory(state.preferences.memoryBudgetMb));
    const tool = defaultTool(kind);
    return { documentIds: [...state.documentIds, document.id], activeDocumentId: document.id, mruOrder: [document.id, ...state.mruOrder], viewports: { ...state.viewports, [document.id]: { ...defaultViewport } }, activeToolByDocument: tool ? { ...state.activeToolByDocument, [document.id]: tool } : state.activeToolByDocument };
  }),
  adoptRestoredDocuments: (documentIds) => set((state) => {
    if (!documentIds.length) return state;
    const viewports = { ...state.viewports }, activeToolByDocument = { ...state.activeToolByDocument };
    for (const id of documentIds) {
      const document = kernel.documents.get(id);
      if (!document) continue;
      kernel.historyByDocument.set(id, createHistory(state.preferences.memoryBudgetMb));
      viewports[id] = { ...defaultViewport };
      const tool = defaultTool(document.kind);
      if (tool) activeToolByDocument[id] = tool;
    }
    const ids = documentIds.filter((id) => kernel.documents.has(id));
    return { documentIds: [...ids], activeDocumentId: ids.at(-1) ?? null, mruOrder: [...ids].reverse(), viewports, activeToolByDocument };
  }),
  adoptDocument: (id) => set((state) => {
    if (state.documentIds.includes(id)) return { activeDocumentId: id, mruOrder: [id, ...state.mruOrder.filter((item) => item !== id)] };
    const document = kernel.documents.get(id);
    if (!document) return state;
    kernel.historyByDocument.set(id, createHistory(state.preferences.memoryBudgetMb));
    const tool = defaultTool(document.kind);
    return {
      documentIds: [...state.documentIds, id],
      activeDocumentId: id,
      mruOrder: [id, ...state.mruOrder],
      viewports: { ...state.viewports, [id]: { ...defaultViewport } },
      activeToolByDocument: tool ? { ...state.activeToolByDocument, [id]: tool } : state.activeToolByDocument,
    };
  }),
  // Opened by id through the modal catalogue rather than by raising a flag
  // here for `App.tsx` to notice: the shell store no longer carries "a dialog
  // is open" for this one dialog (stage 7 of docs/migration-plan.md).
  requestNewDocument: (kind) => { openModal("new-document", { initialKind: kind }); },
  showHome: () => set({ activeDocumentId: null }),
  activateDocument: (id) => set((state) => ({ activeDocumentId: id, mruOrder: [id, ...state.mruOrder.filter((item) => item !== id)] })),
  closeDocument: (id) => set((state) => {
    kernel.documents.close(id);
    void kernel.historyByDocument.get(id)?.clear();
    kernel.historyByDocument.delete(id);
    const documentIds = state.documentIds.filter((documentId) => documentId !== id);
    const mruOrder = state.mruOrder.filter((documentId) => documentId !== id);
    const activeDocumentId = state.activeDocumentId === id ? mruOrder[0] ?? documentIds.at(-1) ?? null : state.activeDocumentId;
    const viewports = { ...state.viewports };
    const editingMaskLayerIdByDocument = { ...state.editingMaskLayerIdByDocument };
    const maskForegroundIsWhiteByDocument = { ...state.maskForegroundIsWhiteByDocument };
    const scene3dOrbitLayerIdByDocument = { ...state.scene3dOrbitLayerIdByDocument };
    const scene3dGroundLayerIdByDocument = { ...state.scene3dGroundLayerIdByDocument };
    delete viewports[id];
    delete editingMaskLayerIdByDocument[id]; delete maskForegroundIsWhiteByDocument[id]; delete scene3dOrbitLayerIdByDocument[id]; delete scene3dGroundLayerIdByDocument[id];
    return { documentIds, mruOrder, activeDocumentId, viewports, editingMaskLayerIdByDocument, maskForegroundIsWhiteByDocument, scene3dOrbitLayerIdByDocument, scene3dGroundLayerIdByDocument };
  }),
  setTool: (documentId, toolId) => set((state) => ({ activeToolByDocument: { ...state.activeToolByDocument, [documentId]: toolId } })),
  setSelectedLayers: (documentId, layerIds) => set((state) => ({ selectedLayerIdsByDocument: { ...state.selectedLayerIdsByDocument, [documentId]: layerIds } })),
  setEditingMask: (documentId, layerId) => set((state) => ({ editingMaskLayerIdByDocument: { ...state.editingMaskLayerIdByDocument, [documentId]: layerId } })),
  setScene3DOrbitLayer: (documentId, layerId) => set((state) => ({ scene3dOrbitLayerIdByDocument: { ...state.scene3dOrbitLayerIdByDocument, [documentId]: layerId } })),
  setScene3DGroundLayer: (documentId, layerId) => set((state) => ({ scene3dGroundLayerIdByDocument: { ...state.scene3dGroundLayerIdByDocument, [documentId]: layerId } })),
  setMaskForegroundWhite: (documentId, white) => set((state) => ({ maskForegroundIsWhiteByDocument: { ...state.maskForegroundIsWhiteByDocument, [documentId]: white } })),
  swapMaskColors: (documentId) => set((state) => ({ maskForegroundIsWhiteByDocument: { ...state.maskForegroundIsWhiteByDocument, [documentId]: !state.maskForegroundIsWhiteByDocument[documentId] } })),
  setToolOption: (toolId, optionId, value) => set((state) => ({ toolOptions: { ...state.toolOptions, [toolId]: { ...(state.toolOptions[toolId] ?? {}), [optionId]: value } } })),
  setViewport: (documentId, patch) => set((state) => ({ viewports: { ...state.viewports, [documentId]: { ...(state.viewports[documentId] ?? defaultViewport), ...patch } } })),
  toggleSelectionEdges: () => set((state) => ({ selectionEdgesHidden: !state.selectionEdgesHidden })),
  setForegroundColor: (foregroundColor) => set({ foregroundColor }),
  setBackgroundColor: (backgroundColor) => set({ backgroundColor }),
  swapColors: () => set((state) => ({ foregroundColor: state.backgroundColor, backgroundColor: state.foregroundColor })),
  resetColors: () => set({ foregroundColor: "#000000", backgroundColor: "#ffffff" }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setTheme: (theme) => { savePreference("vravio.theme", theme); set((state) => {
    const preferences = state.preferences.useCustomInterfacePalette ? state.preferences : { ...state.preferences, interfacePalette: interfacePaletteForTheme(theme) };
    if (!state.preferences.useCustomInterfacePalette) savePreference("vravio.preferences", JSON.stringify(preferences));
    return { theme, preferences };
  }); },
  setLanguage: (language) => { savePreference("vravio.language", language); set({ language }); },
  updatePreferences: (patch) => set((state) => {
    const preferences = { ...state.preferences, ...patch };
    if (patch.memoryBudgetMb !== undefined) { const bytes = Math.max(64, patch.memoryBudgetMb) * 1024 * 1024; for (const history of kernel.historyByDocument.values()) void history.setBudgets(bytes, bytes); }
    if (patch.renderer !== undefined) {
      const requested = patch.renderer === "canvas2d" ? "cpu" : patch.renderer === "auto" ? kernel.gpu.available[0] : patch.renderer;
      if (requested) kernel.gpu.select(requested, "settings");
    }
    savePreference("vravio.preferences", JSON.stringify(preferences));
    return { preferences };
  }),
  resetAppearance: () => set((state) => {
    const preferences = { ...state.preferences, guideColor: defaultPreferences.guideColor, canvasSurround: defaultPreferences.canvasSurround, focusColor: defaultPreferences.focusColor, rasterColor: defaultPreferences.rasterColor, vectorColor: defaultPreferences.vectorColor, audioColor: defaultPreferences.audioColor, videoColor: defaultPreferences.videoColor, interfacePalette: interfacePaletteForTheme(state.theme), useCustomInterfacePalette: false };
    savePreference("vravio.preferences", JSON.stringify(preferences));
    return { preferences };
  }),
  cycleTheme: () => set((state) => {
    const theme = state.theme === "dark" ? "light" : state.theme === "light" ? "contrast" : state.theme === "contrast" ? "ps-dark" : "dark";
    savePreference("vravio.theme", theme);
    return { theme };
  }),
}));
