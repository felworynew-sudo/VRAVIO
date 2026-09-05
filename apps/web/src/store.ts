import { HistoryManager, type EnvironmentKind } from "@vravio/kernel";
import { createRasterDocument } from "@vravio/env-raster";
import { createArtboard, createVectorDocument } from "@vravio/env-vector";
import { create } from "zustand";
import { kernel } from "./kernel";
import { defaultTool, toolById } from "./tools";
import { openModal } from "./modals/runtime";

export type Theme = "dark" | "light" | "contrast";
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
  snapToGuides: boolean;
  smartGuides: boolean;
  showRulers: boolean;
  showGuides: boolean;
  guideColor: string;
  canvasSurround: string;
  focusColor: string;
  rasterColor: string;
  vectorColor: string;
  audioColor: string;
  videoColor: string;
}

const detectedConcurrency = typeof navigator === "undefined" || !navigator.hardwareConcurrency ? 4 : navigator.hardwareConcurrency;

const defaultPreferences: ShellPreferences = {
  renderer: "auto", memoryBudgetMb: 1024, workerCount: Math.max(1, Math.min(8, detectedConcurrency - 1)),
  dragZoom: true, showTooltips: true, contextualBar: true, showPerformanceOverlay: false, snapToGuides: true, smartGuides: true, showRulers: false, showGuides: true,
  guideColor: "#00a8ff", canvasSurround: "#2b2f36", focusColor: "#84a8ff",
  rasterColor: "#a100ff", vectorColor: "#0068ff", audioColor: "#ffb600", videoColor: "#ff0000",
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
  activateDocument(id: string): void;
  closeDocument(id: string): void;
  setTool(documentId: string, toolId: string): void;
  setSelectedLayers(documentId: string, layerIds: string[]): void;
  setEditingMask(documentId: string, layerId: string | null): void;
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
  documentIds: [], activeDocumentId: null, mruOrder: [], activeToolByDocument: {}, selectedLayerIdsByDocument: {}, editingMaskLayerIdByDocument: {}, maskForegroundIsWhiteByDocument: {}, viewports: {}, foregroundColor: "#000000", backgroundColor: "#ffffff", toolOptions: {}, paletteOpen: false, selectionEdgesHidden: false, settingsOpen: false,
  theme: readPreference("vravio.theme", ["dark", "light", "contrast"] as const, "dark"),
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
      : { kind, schemaVersion: 1, ...(options ? { canvas: { width: options.width, height: options.height, resolution: options.resolution, resolutionUnit: options.resolutionUnit, artboards: options.artboards ?? false }, ...(kind === "video" ? { timeline: { frameRate: options.frameRate ?? 30, width: options.width, height: options.height } } : {}), ...(kind === "audio" ? { audio: { sampleRate: options.sampleRate ?? 48000, channels: options.channels ?? 2, bitDepth: options.audioBitDepth ?? 24 } } : {}) } : {}) };
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
    delete viewports[id];
    delete editingMaskLayerIdByDocument[id]; delete maskForegroundIsWhiteByDocument[id];
    return { documentIds, mruOrder, activeDocumentId, viewports, editingMaskLayerIdByDocument, maskForegroundIsWhiteByDocument };
  }),
  setTool: (documentId, toolId) => set((state) => ({ activeToolByDocument: { ...state.activeToolByDocument, [documentId]: toolId } })),
  setSelectedLayers: (documentId, layerIds) => set((state) => ({ selectedLayerIdsByDocument: { ...state.selectedLayerIdsByDocument, [documentId]: layerIds } })),
  setEditingMask: (documentId, layerId) => set((state) => ({ editingMaskLayerIdByDocument: { ...state.editingMaskLayerIdByDocument, [documentId]: layerId } })),
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
  setTheme: (theme) => { savePreference("vravio.theme", theme); set({ theme }); },
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
    const preferences = { ...state.preferences, guideColor: defaultPreferences.guideColor, canvasSurround: defaultPreferences.canvasSurround, focusColor: defaultPreferences.focusColor, rasterColor: defaultPreferences.rasterColor, vectorColor: defaultPreferences.vectorColor, audioColor: defaultPreferences.audioColor, videoColor: defaultPreferences.videoColor };
    savePreference("vravio.preferences", JSON.stringify(preferences));
    return { preferences };
  }),
  cycleTheme: () => set((state) => {
    const theme = state.theme === "dark" ? "light" : state.theme === "light" ? "contrast" : "dark";
    savePreference("vravio.theme", theme);
    return { theme };
  }),
}));
