import type { CommandContext, EnvironmentKind } from "@vravio/kernel";
import { activeRasterLayer, groupLayers, layerFromSelection, mergeLayerDown, mergeVisibleLayers, moveLayerInStack, selectAllPixels, stampVisibleLayers, ungroupLayer, createRasterLayer, invertPixelSelection, isRasterDocumentState, restrictSelectionToAlpha, selectOpaquePixels, type PixelSelection, type RasterDocumentState, type RasterLayer } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { useShellStore } from "./store";

let initialized = false;

/** The selection each document last had, so Reselect has something to restore. */
const lastSelectionByDocument = new Map<string, PixelSelection>();

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

/**
 * Applies a change to the layer tree as one undoable step.
 *
 * Layer operations rearrange structure and can rewrite pixels, so the step
 * holds a snapshot of each side. The snapshots share their pixel buffers with
 * the document — every path that edits pixels replaces the buffer rather than
 * writing through it — so the cost is the tree, not the image.
 */
async function changeRasterDocument(documentId: string, label: string, mutate: (state: RasterDocumentState) => boolean): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  const history = kernel.historyByDocument.get(documentId);
  if (!document || !history || !isRasterDocumentState(document.state)) return;

  const before = snapshotLayers(document.state);
  const draft = snapshotLayers(document.state);
  const working: RasterDocumentState = { ...document.state, layers: draft.layers, activeLayerId: draft.activeLayerId, selection: document.state.selection };
  if (!mutate(working)) return;
  const after = { layers: working.layers, activeLayerId: working.activeLayerId };

  const assign = (snapshot: { layers: RasterLayer[]; activeLayerId: string }): void => {
    kernel.documents.update<RasterDocumentState>(documentId, (state) => {
      state.layers = snapshot.layers.map((layer) => ({ ...layer }));
      state.activeLayerId = snapshot.activeLayerId;
    });
  };
  await history.execute({
    label,
    memoryEstimate: 0,
    redo: () => assign(after),
    undo: () => assign(before),
  });
}

/** Copies the layer tree's structure while sharing the pixel buffers. */
function snapshotLayers(state: RasterDocumentState): { layers: RasterLayer[]; activeLayerId: string } {
  return {
    layers: state.layers.map((layer) => ({
      ...layer,
      ...(layer.mask ? { mask: { ...layer.mask } } : {}),
      ...(layer.text ? { text: structuredClone(layer.text) } : {}),
      ...(layer.adjustment ? { adjustment: structuredClone(layer.adjustment) } : {}),
    })),
    activeLayerId: state.activeLayerId,
  };
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
  kernel.commands.register({ id: "file.export", label: "Export… (Экспортировать…)", category: "File (Файл)", shortcut: "Mod+Shift+Alt+W", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: () => dispatch("vravio-file-export") });
  kernel.commands.register({ id: "file.close", label: "Close Document (Закрыть документ)", category: "File (Файл)", shortcut: "Mod+W", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().closeDocument(activeDocumentId); } });
  kernel.commands.register({
    id: "layer.openElsewhere",
    label: "Edit Layer in Its Own Tab (Открыть слой в отдельной вкладке)",
    category: "Layer (Слой)",
    isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster",
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openTargetElsewhere(activeDocumentId, "raster", false); },
  });
  kernel.commands.register({
    id: "layer.openElsewhereBranch",
    label: "Edit Layer as a Copy (Открыть слой копией)",
    category: "Layer (Слой)",
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
  // Photoshop's layer shortcuts, in its own order and with its own keys.
  const raster = ({ activeDocumentId }: { activeDocumentId?: string | null }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster";
  const editLayers = (documentId: string, label: string, mutate: (state: RasterDocumentState) => boolean) =>
    changeRasterDocument(documentId, label, mutate);

  kernel.commands.register({ id: "layer.duplicate", label: "Duplicate Layer (Создать дубликат слоя)", category: "Layer (Слой)", shortcut: "Mod+J", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const document = kernel.documents.get<RasterDocumentState>(activeDocumentId); if (!document) return; void editLayers(activeDocumentId, "Layer via Copy (Слой копированием)", (state) => Boolean(layerFromSelection(state, state.activeLayerId, state.selection, false))); } });
  kernel.commands.register({ id: "layer.viaCut", label: "Layer via Cut (Вырезать на новый слой)", category: "Layer (Слой)", shortcut: "Mod+Shift+J", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection), execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Layer via Cut (Слой вырезанием)", (state) => Boolean(layerFromSelection(state, state.activeLayerId, state.selection, true))); } });
  kernel.commands.register({ id: "layer.mergeDown", label: "Merge Down (Объединить с предыдущим)", category: "Layer (Слой)", shortcut: "Mod+E", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Merge Down (Объединить с предыдущим)", (state) => Boolean(mergeLayerDown(state, state.activeLayerId))); } });
  kernel.commands.register({ id: "layer.mergeVisible", label: "Merge Visible (Объединить видимые)", category: "Layer (Слой)", shortcut: "Mod+Shift+E", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Merge Visible (Объединить видимые)", (state) => Boolean(mergeVisibleLayers(state))); } });
  kernel.commands.register({ id: "layer.stampVisible", label: "Stamp Visible (Отпечаток видимых)", category: "Layer (Слой)", shortcut: "Mod+Shift+Alt+E", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Stamp Visible (Отпечаток видимых)", (state) => Boolean(stampVisibleLayers(state))); } });
  kernel.commands.register({ id: "layer.group", label: "Group Layers (Сгруппировать слои)", category: "Layer (Слой)", shortcut: "Mod+G", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const chosen = useShellStore.getState().selectedLayerIdsByDocument[activeDocumentId] ?? []; void editLayers(activeDocumentId, "Group Layers (Сгруппировать слои)", (state) => Boolean(groupLayers(state, chosen.length ? chosen : [state.activeLayerId]))); } });
  kernel.commands.register({ id: "layer.ungroup", label: "Ungroup Layers (Разгруппировать слои)", category: "Layer (Слой)", shortcut: "Mod+Shift+G", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Ungroup Layers (Разгруппировать слои)", (state) => ungroupLayer(state, state.activeLayerId)); } });
  for (const [id, label, shortcut, move] of [
    ["layer.bringForward", "Bring Forward (Переложить вперёд)", "Mod+]", "up"],
    ["layer.sendBackward", "Send Backward (Переложить назад)", "Mod+[", "down"],
    ["layer.bringToFront", "Bring to Front (На передний план)", "Mod+Shift+]", "top"],
    ["layer.sendToBack", "Send to Back (На задний план)", "Mod+Shift+[", "bottom"],
  ] as const) {
    kernel.commands.register({ id, label, category: "Layer (Слой)", shortcut, isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, label, (state) => moveLayerInStack(state, state.activeLayerId, move)); } });
  }

  kernel.commands.register({ id: "edit.undo", label: "Undo (Отменить)", category: "Edit (Правка)", shortcut: "Mod+Z", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.historyByDocument.get(activeDocumentId)?.canUndo), execute: async ({ activeDocumentId }) => { if (activeDocumentId) await kernel.historyByDocument.get(activeDocumentId)?.undo(); } });
  kernel.commands.register({ id: "edit.redo", label: "Redo (Повторить)", category: "Edit (Правка)", shortcut: "Mod+Shift+Z", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.historyByDocument.get(activeDocumentId)?.canRedo), execute: async ({ activeDocumentId }) => { if (activeDocumentId) await kernel.historyByDocument.get(activeDocumentId)?.redo(); } });
  // Select All takes the whole canvas, as it does in Photoshop. Selecting the
  // layer's opaque pixels is a different operation and keeps its own entry.
  kernel.commands.register({ id: "select.all", label: "Select All (Выделить все)", category: "Select (Выделение)", shortcut: "Mod+A", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Select All (Выделить все)", (state) => selectAllPixels(state.width, state.height)); } });
  kernel.commands.register({ id: "select.opaque", label: "Select Layer Content (Выделить содержимое слоя)", category: "Select (Выделение)", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Select Layer Content (Выделить содержимое слоя)", (state) => selectOpaquePixels(activeRasterLayer(state).pixels, state.width, state.height)); } });
  kernel.commands.register({ id: "select.none", label: "Deselect (Снять выделение)", category: "Select (Выделение)", shortcut: "Mod+D", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && isRasterDocumentState(kernel.documents.get(activeDocumentId)?.state) && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection), execute: async ({ activeDocumentId }) => { if (!activeDocumentId) return; const current = kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection; if (current) lastSelectionByDocument.set(activeDocumentId, { mask: current.mask.slice(), bounds: { ...current.bounds } }); await changeRasterSelection(activeDocumentId, "Deselect (Снять выделение)", () => null); } });
  kernel.commands.register({ id: "select.reselect", label: "Reselect (Выделить снова)", category: "Select (Выделение)", shortcut: "Mod+Shift+D", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && lastSelectionByDocument.has(activeDocumentId)), execute: async ({ activeDocumentId }) => { if (!activeDocumentId) return; const previous = lastSelectionByDocument.get(activeDocumentId); if (previous) await changeRasterSelection(activeDocumentId, "Reselect (Выделить снова)", () => ({ mask: previous.mask.slice(), bounds: { ...previous.bounds } })); } });
  kernel.commands.register({ id: "select.feather", label: "Feather Selection… (Растушевать выделение…)", category: "Select (Выделение)", shortcut: "Shift+F6", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection), execute: () => dispatch("vravio-select-feather") });
  kernel.commands.register({ id: "select.hideEdges", label: "Show/Hide Selection Edges (Показать/скрыть края выделения)", category: "View (Просмотр)", shortcut: "Mod+H", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: () => useShellStore.getState().toggleSelectionEdges() });
  kernel.commands.register({ id: "select.invert", label: "Invert Selection (Инвертировать выделение)", category: "Select (Выделение)", shortcut: "Mod+Shift+I", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Invert Selection (Инвертировать выделение)", (state) => restrictSelectionToAlpha(invertPixelSelection(state.selection, state.width, state.height), activeRasterLayer(state).pixels, state.width, state.height)); } });
  kernel.commands.register({ id: "view.fit", label: "Fit on Screen (Подогнать по экрану)", category: "View (Просмотр)", shortcut: "Mod+0", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { mode: "fit", panX: 0, panY: 0 }); } });
  kernel.commands.register({ id: "view.actual", label: "Actual Size 100% (Реальный размер 100%)", category: "View (Просмотр)", shortcut: "Mod+1", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { mode: "actual", zoom: 1, panX: 0, panY: 0 }); } });
  kernel.commands.register({ id: "view.zoomIn", label: "Zoom In (Увеличить масштаб)", category: "View (Просмотр)", shortcut: "Mod++", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const current = useShellStore.getState().viewports[activeDocumentId]; useShellStore.getState().setViewport(activeDocumentId, { mode: "custom", zoom: Math.min(64, (current?.zoom ?? 1) * 1.25) }); } });
  kernel.commands.register({ id: "view.zoomOut", label: "Zoom Out (Уменьшить масштаб)", category: "View (Просмотр)", shortcut: "Mod+-", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const current = useShellStore.getState().viewports[activeDocumentId]; useShellStore.getState().setViewport(activeDocumentId, { mode: "custom", zoom: Math.max(0.01, (current?.zoom ?? 1) / 1.25) }); } });
  kernel.commands.register({ id: "view.resetRotation", label: "Reset View Rotation (Сбросить вращение вида)", category: "View (Просмотр)", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { rotation: 0 }); } });
  kernel.commands.register({ id: "view.theme", label: "Cycle Theme (Сменить тему)", category: "View (Просмотр)", execute: () => useShellStore.getState().cycleTheme() });
  kernel.commands.register({ id: "app.settings", label: "Settings (Настройки)", category: "Edit (Правка)", execute: () => useShellStore.getState().setSettingsOpen(true) });
  kernel.commands.register({ id: "view.commandPalette", label: "Search (Поиск)", category: "Edit (Правка)", shortcut: "Mod+F", execute: () => useShellStore.getState().setPaletteOpen(true) });
  for (const command of kernel.commands.list()) if (command.shortcut) kernel.keymap.bind(command.id, command.shortcut);
}

export function activeCommandContext(): CommandContext {
  return { activeDocumentId: useShellStore.getState().activeDocumentId };
}
