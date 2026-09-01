import type { CommandContext, EnvironmentKind } from "@vravio/kernel";
import { activeRasterLayer, createRasterLayer, invertPixelSelection, isRasterDocumentState, restrictSelectionToAlpha, selectOpaquePixels, type PixelSelection, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { useShellStore } from "./store";

let initialized = false;

function cloneSelection(selection: PixelSelection | null): PixelSelection | null {
  return selection ? { mask: selection.mask.slice(), bounds: { ...selection.bounds } } : null;
}

async function changeRasterSelection(documentId: string, label: string, change: (state: RasterDocumentState) => PixelSelection | null): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history || !isRasterDocumentState(document.state)) return;
  const before = cloneSelection(document.state.selection);
  const after = cloneSelection(change(document.state));
  const assign = (selection: PixelSelection | null): void => { kernel.documents.update<RasterDocumentState>(documentId, (state) => { state.selection = cloneSelection(selection); }); };
  await history.execute({ label, redo: () => assign(after), undo: () => assign(before) });
}

export function ensureCommandsRegistered(): void {
  if (initialized) return;
  initialized = true;
  const registerNew = (kind: EnvironmentKind, label: string) => kernel.commands.register({ id: `file.new.${kind}`, label, category: "File (Файл)", execute: () => kind === "raster" || kind === "vector" ? useShellStore.getState().requestNewDocument(kind) : useShellStore.getState().openDocument(kind) });
  registerNew("raster", "New Raster Document (Новый растровый документ)");
  registerNew("vector", "New Vector Document (Новый векторный документ)");
  registerNew("audio", "New Audio Document (Новый аудиодокумент)");
  registerNew("video", "New Video Document (Новый видеодокумент)");
  kernel.commands.register({ id: "file.save", label: "Save (Сохранить)", category: "File (Файл)", shortcut: "Mod+S", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) kernel.documents.markSaved(activeDocumentId); } });
  kernel.commands.register({ id: "file.close", label: "Close Document (Закрыть документ)", category: "File (Файл)", shortcut: "Mod+W", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().closeDocument(activeDocumentId); } });
  kernel.commands.register({ id: "layer.new", label: "New Layer (Новый слой)", category: "Layer (Слой)", shortcut: "Mod+Shift+N", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; kernel.documents.update<RasterDocumentState>(activeDocumentId, (state) => { const layer = createRasterLayer(state.width, state.height, `Layer ${state.layers.length + 1} (Слой ${state.layers.length + 1})`); state.layers.push(layer); state.activeLayerId = layer.id; }); } });
  kernel.commands.register({ id: "edit.undo", label: "Undo (Отменить)", category: "Edit (Правка)", shortcut: "Mod+Z", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.historyByDocument.get(activeDocumentId)?.canUndo), execute: async ({ activeDocumentId }) => { if (activeDocumentId) await kernel.historyByDocument.get(activeDocumentId)?.undo(); } });
  kernel.commands.register({ id: "edit.redo", label: "Redo (Повторить)", category: "Edit (Правка)", shortcut: "Mod+Shift+Z", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.historyByDocument.get(activeDocumentId)?.canRedo), execute: async ({ activeDocumentId }) => { if (activeDocumentId) await kernel.historyByDocument.get(activeDocumentId)?.redo(); } });
  kernel.commands.register({ id: "select.all", label: "Select All Content (Выделить содержимое)", category: "Select (Выделение)", shortcut: "Mod+A", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Select All Content (Выделить содержимое)", (state) => selectOpaquePixels(activeRasterLayer(state).pixels, state.width, state.height)); } });
  kernel.commands.register({ id: "select.none", label: "Deselect (Снять выделение)", category: "Select (Выделение)", shortcut: "Mod+Shift+A", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && isRasterDocumentState(kernel.documents.get(activeDocumentId)?.state) && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection), execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Deselect (Снять выделение)", () => null); } });
  kernel.commands.register({ id: "select.invert", label: "Invert Selection (Инвертировать выделение)", category: "Select (Выделение)", shortcut: "Mod+Shift+I", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Invert Selection (Инвертировать выделение)", (state) => restrictSelectionToAlpha(invertPixelSelection(state.selection, state.width, state.height), activeRasterLayer(state).pixels, state.width, state.height)); } });
  kernel.commands.register({ id: "view.fit", label: "Fit on Screen (Подогнать по экрану)", category: "View (Просмотр)", shortcut: "Mod+0", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { mode: "fit", panX: 0, panY: 0 }); } });
  kernel.commands.register({ id: "view.actual", label: "Actual Size 100% (Реальный размер 100%)", category: "View (Просмотр)", shortcut: "Mod+1", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { mode: "actual", zoom: 1, panX: 0, panY: 0 }); } });
  kernel.commands.register({ id: "view.zoomIn", label: "Zoom In (Увеличить масштаб)", category: "View (Просмотр)", shortcut: "Mod++", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const current = useShellStore.getState().viewports[activeDocumentId]; useShellStore.getState().setViewport(activeDocumentId, { mode: "custom", zoom: Math.min(64, (current?.zoom ?? 1) * 1.25) }); } });
  kernel.commands.register({ id: "view.zoomOut", label: "Zoom Out (Уменьшить масштаб)", category: "View (Просмотр)", shortcut: "Mod+-", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const current = useShellStore.getState().viewports[activeDocumentId]; useShellStore.getState().setViewport(activeDocumentId, { mode: "custom", zoom: Math.max(0.01, (current?.zoom ?? 1) / 1.25) }); } });
  kernel.commands.register({ id: "view.resetRotation", label: "Reset View Rotation (Сбросить вращение вида)", category: "View (Просмотр)", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { rotation: 0 }); } });
  kernel.commands.register({ id: "view.theme", label: "Cycle Theme (Сменить тему)", category: "View (Просмотр)", execute: () => useShellStore.getState().cycleTheme() });
  kernel.commands.register({ id: "app.settings", label: "Settings (Настройки)", category: "Edit (Правка)", execute: () => useShellStore.getState().setSettingsOpen(true) });
  kernel.commands.register({ id: "view.commandPalette", label: "Command Palette (Палитра команд)", category: "View (Просмотр)", shortcut: "Mod+K", execute: () => useShellStore.getState().setPaletteOpen(true) });
}

export function activeCommandContext(): CommandContext {
  return { activeDocumentId: useShellStore.getState().activeDocumentId };
}
