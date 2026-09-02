import type { CommandContext, EnvironmentKind } from "@vravio/kernel";
import { activeRasterLayer, createRasterLayer, invertPixelSelection, isRasterDocumentState, restrictSelectionToAlpha, selectOpaquePixels, type PixelSelection, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { useShellStore } from "./store";

let initialized = false;

function cloneSelection(selection: PixelSelection | null): PixelSelection | null {
  return selection ? { mask: selection.mask.slice(), bounds: { ...selection.bounds } } : null;
}

/**
 * Opens the active layer as a document of its own and links the two.
 *
 * The layer's pixels become an asset that both documents point at, so applying
 * from the child sends a revision back and the parent picks it up. Nothing in
 * this command knows how that happens; that is the kernel's round-trip
 * manager's business, and the same command will open a layer in the vector or
 * 3D environment once those exist.
 */
async function openTargetElsewhere(documentId: string, targetEnv: EnvironmentKind, branch: boolean): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const layer = activeRasterLayer(document.state);
  if (!layer) return;

  const session = await kernel.roundtrip.open({
    parentDocId: documentId,
    target: { kind: "raster-layer", layerId: layer.id },
    targetEnv,
    branch,
  });
  useShellStore.getState().adoptDocument(session.childDocId);
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
  const registerNew = (kind: EnvironmentKind, label: string) => kernel.commands.register({ id: `file.new.${kind}`, label, category: "File (Файл)", ...(kind === "raster" ? { shortcut: "Mod+N" } : {}), execute: () => kind === "raster" || kind === "vector" ? useShellStore.getState().requestNewDocument(kind) : useShellStore.getState().openDocument(kind) });
  registerNew("raster", "New Raster Document (Новый растровый документ)");
  registerNew("vector", "New Vector Document (Новый векторный документ)");
  registerNew("audio", "New Audio Document (Новый аудиодокумент)");
  registerNew("video", "New Video Document (Новый видеодокумент)");
  // File commands own the shortcut and the menu entry, but the actual write lives in the
  // shell (it needs the platform port and the export dialog), so they dispatch instead of
  // saving here. Marking the document clean without writing anything would lose work.
  const dispatch = (type: string): void => { window.dispatchEvent(new Event(type)); };
  kernel.commands.register({ id: "file.save", label: "Save (Сохранить)", category: "File (Файл)", shortcut: "Mod+S", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: () => dispatch("vravio-file-save") });
  kernel.commands.register({ id: "file.saveAs", label: "Save As… (Сохранить как…)", category: "File (Файл)", shortcut: "Mod+Shift+S", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: () => dispatch("vravio-file-save-as") });
  kernel.commands.register({ id: "file.saveCopy", label: "Save a Copy… (Сохранить копию…)", category: "File (Файл)", shortcut: "Mod+Alt+S", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: () => dispatch("vravio-file-save-copy") });
  kernel.commands.register({ id: "file.export", label: "Export… (Экспортировать…)", category: "File (Файл)", shortcut: "Mod+Shift+E", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: () => dispatch("vravio-file-export") });
  kernel.commands.register({ id: "file.close", label: "Close Document (Закрыть документ)", category: "File (Файл)", shortcut: "Mod+W", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().closeDocument(activeDocumentId); } });
  kernel.commands.register({
    id: "layer.openElsewhere",
    label: "Edit Layer in Its Own Tab (Открыть слой в отдельной вкладке)",
    category: "Layer (Слой)",
    shortcut: "Mod+E",
    isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster",
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openTargetElsewhere(activeDocumentId, "raster", false); },
  });
  kernel.commands.register({
    id: "layer.openElsewhereBranch",
    label: "Edit Layer as a Copy (Открыть слой копией)",
    category: "Layer (Слой)",
    shortcut: "Mod+Alt+E",
    isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster",
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openTargetElsewhere(activeDocumentId, "raster", true); },
  });
  kernel.commands.register({
    id: "roundtrip.apply",
    label: "Apply to Parent Document (Применить в исходный документ)",
    category: "File (Файл)",
    shortcut: "Mod+Shift+Return",
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.roundtrip.sessionOf(activeDocumentId)?.status !== undefined && kernel.documents.get(activeDocumentId)?.provenance),
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void kernel.roundtrip.apply(activeDocumentId); },
  });
  kernel.commands.register({
    id: "roundtrip.detach",
    label: "Detach from Parent (Отвязать от исходного)",
    category: "File (Файл)",
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.documents.get(activeDocumentId)?.provenance),
    execute: ({ activeDocumentId }) => { if (activeDocumentId) kernel.roundtrip.detach(activeDocumentId); },
  });
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
  for (const command of kernel.commands.list()) if (command.shortcut) kernel.keymap.bind(command.id, command.shortcut);
}

export function activeCommandContext(): CommandContext {
  return { activeDocumentId: useShellStore.getState().activeDocumentId };
}
