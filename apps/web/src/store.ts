import { HistoryManager, type EnvironmentKind } from "@vravio/kernel";
import { createRasterDocument } from "@vravio/env-raster";
import { create } from "zustand";
import { kernel } from "./kernel";
import { defaultTool, toolById } from "./tools";

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
  dragZoom: true, showTooltips: true, contextualBar: true, snapToGuides: true, smartGuides: true, showRulers: false, showGuides: true,
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
  viewports: Record<string, DocumentViewport>;
  foregroundColor: string;
  backgroundColor: string;
  toolOptions: Record<string, Record<string, string | number | boolean>>;
  paletteOpen: boolean;
  settingsOpen: boolean;
  newDocumentKind: EnvironmentKind | null;
  theme: Theme;
  language: Language;
  preferences: ShellPreferences;
  openDocument(kind: EnvironmentKind, options?: NewDocumentOptions): void;
  adoptRestoredDocuments(documentIds: readonly string[]): void;
  requestNewDocument(kind: EnvironmentKind): void;
  cancelNewDocument(): void;
  activateDocument(id: string): void;
  closeDocument(id: string): void;
  setTool(documentId: string, toolId: string): void;
  setSelectedLayers(documentId: string, layerIds: string[]): void;
  setToolOption(toolId: string, optionId: string, value: string | number | boolean): void;
  setViewport(documentId: string, patch: Partial<DocumentViewport>): void;
  setForegroundColor(color: string): void;
  setBackgroundColor(color: string): void;
  swapColors(): void;
  resetColors(): void;
  setPaletteOpen(open: boolean): void;
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

export const useShellStore = create<ShellState>((set) => ({
  documentIds: [], activeDocumentId: null, mruOrder: [], activeToolByDocument: {}, selectedLayerIdsByDocument: {}, viewports: {}, foregroundColor: "#000000", backgroundColor: "#ffffff", toolOptions: {}, paletteOpen: false, settingsOpen: false, newDocumentKind: null,
  theme: readPreference("vravio.theme", ["dark", "light", "contrast"] as const, "dark"),
  language: readPreference("vravio.language", ["en", "ru", "uk", "es", "de", "ja", "zh"] as const, "ru"),
  preferences: readPreferences(),
  openDocument: (kind, options) => set((state) => {
    const initialState = kind === "raster"
      ? createRasterDocument(options?.width, options?.height, options ? { resolution: options.resolution, resolutionUnit: options.resolutionUnit, backgroundColor: options.backgroundColor, pixelAspectRatio: options.pixelAspectRatio } : {})
      : { kind, schemaVersion: 1, ...(options ? { canvas: { width: options.width, height: options.height, resolution: options.resolution, resolutionUnit: options.resolutionUnit, artboards: options.artboards ?? false }, ...(kind === "video" ? { timeline: { frameRate: options.frameRate ?? 30, width: options.width, height: options.height } } : {}), ...(kind === "audio" ? { audio: { sampleRate: options.sampleRate ?? 48000, channels: options.channels ?? 2, bitDepth: options.audioBitDepth ?? 24 } } : {}) } : {}) };
    const document = kernel.documents.create(kind, options?.name?.trim() || names[kind], initialState);
    kernel.historyByDocument.set(document.id, new HistoryManager());
    const tool = defaultTool(kind);
    return { documentIds: [...state.documentIds, document.id], activeDocumentId: document.id, mruOrder: [document.id, ...state.mruOrder], newDocumentKind: null, viewports: { ...state.viewports, [document.id]: { ...defaultViewport } }, activeToolByDocument: tool ? { ...state.activeToolByDocument, [document.id]: tool } : state.activeToolByDocument };
  }),
  adoptRestoredDocuments: (documentIds) => set((state) => {
    if (!documentIds.length) return state;
    const viewports = { ...state.viewports }, activeToolByDocument = { ...state.activeToolByDocument };
    for (const id of documentIds) {
      const document = kernel.documents.get(id);
      if (!document) continue;
      kernel.historyByDocument.set(id, new HistoryManager());
      viewports[id] = { ...defaultViewport };
      const tool = defaultTool(document.kind);
      if (tool) activeToolByDocument[id] = tool;
    }
    const ids = documentIds.filter((id) => kernel.documents.has(id));
    return { documentIds: [...ids], activeDocumentId: ids.at(-1) ?? null, mruOrder: [...ids].reverse(), viewports, activeToolByDocument };
  }),
  requestNewDocument: (newDocumentKind) => set({ newDocumentKind }),
  cancelNewDocument: () => set({ newDocumentKind: null }),
  activateDocument: (id) => set((state) => ({ activeDocumentId: id, mruOrder: [id, ...state.mruOrder.filter((item) => item !== id)] })),
  closeDocument: (id) => set((state) => {
    kernel.documents.close(id);
    kernel.historyByDocument.delete(id);
    const documentIds = state.documentIds.filter((documentId) => documentId !== id);
    const mruOrder = state.mruOrder.filter((documentId) => documentId !== id);
    const activeDocumentId = state.activeDocumentId === id ? mruOrder[0] ?? documentIds.at(-1) ?? null : state.activeDocumentId;
    const viewports = { ...state.viewports };
    delete viewports[id];
    return { documentIds, mruOrder, activeDocumentId, viewports };
  }),
  setTool: (documentId, toolId) => set((state) => ({ activeToolByDocument: { ...state.activeToolByDocument, [documentId]: toolId } })),
  setSelectedLayers: (documentId, layerIds) => set((state) => ({ selectedLayerIdsByDocument: { ...state.selectedLayerIdsByDocument, [documentId]: layerIds } })),
  setToolOption: (toolId, optionId, value) => set((state) => ({ toolOptions: { ...state.toolOptions, [toolId]: { ...(state.toolOptions[toolId] ?? {}), [optionId]: value } } })),
  setViewport: (documentId, patch) => set((state) => ({ viewports: { ...state.viewports, [documentId]: { ...(state.viewports[documentId] ?? defaultViewport), ...patch } } })),
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
