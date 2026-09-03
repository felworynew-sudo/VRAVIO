import type { CommandContext, EnvironmentKind } from "@vravio/kernel";
import { activeRasterLayer, groupLayers, layerDocumentPixels, layerFromSelection, mergeLayerDown, mergeVisibleLayers, moveLayerInStack, removeLayer, selectAllPixels, stampVisibleLayers, ungroupLayer, createRasterLayer, invertPixelSelection, isRasterDocumentState, restrictSelectionToAlpha, selectOpaquePixels, type PixelSelection, type RasterDocumentState, type RasterLayer } from "@vravio/env-raster";
import { isVectorDocumentState, type VectorDocumentState } from "@vravio/env-vector";
import { legacyBilingualLabel, resolveLabel, type LocalizedText } from "./i18n";
import { kernel } from "./kernel";
import { createScene3DExtrudeLayer, createScene3DTextLayer } from "./scene3d-commands";
import { useShellStore } from "./store";
import { tools } from "./tools";
import { applyShortcutOverrides, rememberDefaultShortcut } from "./shortcuts";

let initialized = false;

/**
 * One constant per menu category, resolved through `legacyBilingualLabel` at
 * each registration site.
 *
 * Commands register once at startup (`ensureCommandsRegistered`'s guard),
 * not fresh on every render the way a `ToolDefinition` is read — so
 * `Command.category`/`.label` stay the same concatenated-string shape
 * `localized()` already parses, built here from structured data instead of
 * re-typed by hand at every call site. See `legacyBilingualLabel`'s own
 * comment in i18n.ts for why the kernel side of this isn't restructured yet.
 */
const CATEGORY_FILE: LocalizedText = { en: "File", ru: "Файл" };
const CATEGORY_LAYER: LocalizedText = { en: "Layer", ru: "Слой" };
const CATEGORY_EDIT: LocalizedText = { en: "Edit", ru: "Правка" };
const CATEGORY_SELECT: LocalizedText = { en: "Select", ru: "Выделение" };
const CATEGORY_VIEW: LocalizedText = { en: "View", ru: "Просмотр" };
const CATEGORY_FILTER: LocalizedText = { en: "Filter", ru: "Фильтр" };
const CATEGORY_IMAGE: LocalizedText = { en: "Image", ru: "Изображение" };
const CATEGORY_3D: LocalizedText = { en: "3D", ru: "3D" };
const CATEGORY_OBJECT: LocalizedText = { en: "Object", ru: "Объект" };
const CATEGORY_TOOLS: LocalizedText = { en: "Tools", ru: "Инструменты" };

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

/** Opens the active image shape's picture as a raster document of its own, the vector-side
 * counterpart to openTargetElsewhere — same round-trip manager, same asset-reference mechanism,
 * just a `vector-node` target instead of a `raster-layer` one. */
async function openVectorImageElsewhere(documentId: string, branch: boolean): Promise<void> {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  if (!document || !isVectorDocumentState(document.state)) return;
  const shape = document.state.shapes.find((item) => item.id === document.state.activeShapeId);
  if (!shape || shape.kind !== "image") return;

  const session = await kernel.roundtrip.open({
    parentDocId: documentId,
    target: { kind: "vector-node", nodeId: shape.id },
    targetEnv: "raster",
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
export async function changeRasterDocument(documentId: string, label: string, mutate: (state: RasterDocumentState) => boolean): Promise<void> {
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
  const registerNew = (kind: EnvironmentKind, label: LocalizedText) => kernel.commands.register({ id: `file.new.${kind}`, label: legacyBilingualLabel(label), category: legacyBilingualLabel(CATEGORY_FILE), ...(kind === "raster" ? { shortcut: "Mod+N" } : {}), execute: () => kind === "raster" || kind === "vector" ? useShellStore.getState().requestNewDocument(kind) : useShellStore.getState().openDocument(kind) });
  registerNew("raster", { en: "New Raster Document", ru: "Новый растровый документ" });
  registerNew("vector", { en: "New Vector Document", ru: "Новый векторный документ" });
  registerNew("audio", { en: "New Audio Document", ru: "Новый аудиодокумент" });
  registerNew("video", { en: "New Video Document", ru: "Новый видеодокумент" });
  // File commands own the shortcut and the menu entry, but the actual write lives in the
  // shell (it needs the platform port and the export dialog), so they dispatch instead of
  // saving here. Marking the document clean without writing anything would lose work.
  const dispatch = (type: string): void => { window.dispatchEvent(new Event(type)); };
  kernel.commands.register({ id: "file.open", label: legacyBilingualLabel({ en: "Open…", ru: "Открыть…" }), category: legacyBilingualLabel(CATEGORY_FILE), shortcut: "Mod+O", execute: () => dispatch("vravio-file-open") });
  kernel.commands.register({ id: "file.save", label: legacyBilingualLabel({ en: "Save", ru: "Сохранить" }), category: legacyBilingualLabel(CATEGORY_FILE), shortcut: "Mod+S", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: () => dispatch("vravio-file-save") });
  kernel.commands.register({ id: "file.saveAs", label: legacyBilingualLabel({ en: "Save As…", ru: "Сохранить как…" }), category: legacyBilingualLabel(CATEGORY_FILE), shortcut: "Mod+Shift+S", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: () => dispatch("vravio-file-save-as") });
  kernel.commands.register({ id: "file.saveCopy", label: legacyBilingualLabel({ en: "Save a Copy…", ru: "Сохранить копию…" }), category: legacyBilingualLabel(CATEGORY_FILE), shortcut: "Mod+Alt+S", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: () => dispatch("vravio-file-save-copy") });
  kernel.commands.register({ id: "file.export", label: legacyBilingualLabel({ en: "Export…", ru: "Экспортировать…" }), category: legacyBilingualLabel(CATEGORY_FILE), shortcut: "Mod+Shift+Alt+W", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: () => dispatch("vravio-file-export") });
  kernel.commands.register({ id: "file.close", label: legacyBilingualLabel({ en: "Close Document", ru: "Закрыть документ" }), category: legacyBilingualLabel(CATEGORY_FILE), shortcut: "Mod+W", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().closeDocument(activeDocumentId); } });
  kernel.commands.register({
    id: "layer.openElsewhere",
    label: legacyBilingualLabel({ en: "Edit Layer in Its Own Tab", ru: "Открыть слой в отдельной вкладке" }),
    category: legacyBilingualLabel(CATEGORY_LAYER),
    isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster",
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openTargetElsewhere(activeDocumentId, "raster", false); },
  });
  kernel.commands.register({
    id: "layer.openElsewhereBranch",
    label: legacyBilingualLabel({ en: "Edit Layer as a Copy", ru: "Открыть слой копией" }),
    category: legacyBilingualLabel(CATEGORY_LAYER),
    isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster",
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openTargetElsewhere(activeDocumentId, "raster", true); },
  });
  const hasActiveImageShape = ({ activeDocumentId }: { activeDocumentId?: string | null }) => {
    const document = kernel.documents.get<VectorDocumentState>(activeDocumentId ?? "");
    if (!document || !isVectorDocumentState(document.state)) return false;
    const shape = document.state.shapes.find((item) => item.id === document.state.activeShapeId);
    return shape?.kind === "image";
  };
  kernel.commands.register({
    id: "image.openElsewhere",
    label: legacyBilingualLabel({ en: "Edit Image in Raster Environment", ru: "Открыть картинку в растровой среде" }),
    category: legacyBilingualLabel(CATEGORY_OBJECT),
    isEnabled: hasActiveImageShape,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openVectorImageElsewhere(activeDocumentId, false); },
  });
  kernel.commands.register({
    id: "image.openElsewhereBranch",
    label: legacyBilingualLabel({ en: "Edit Image as a Copy", ru: "Открыть картинку копией" }),
    category: legacyBilingualLabel(CATEGORY_OBJECT),
    isEnabled: hasActiveImageShape,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openVectorImageElsewhere(activeDocumentId, true); },
  });
  kernel.commands.register({
    id: "roundtrip.apply",
    label: legacyBilingualLabel({ en: "Apply to Parent Document", ru: "Применить в исходный документ" }),
    category: legacyBilingualLabel(CATEGORY_FILE),
    shortcut: "Mod+Shift+Enter",
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.roundtrip.sessionOf(activeDocumentId)?.status !== undefined && kernel.documents.get(activeDocumentId)?.provenance),
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void kernel.roundtrip.apply(activeDocumentId); },
  });
  kernel.commands.register({
    id: "roundtrip.detach",
    label: legacyBilingualLabel({ en: "Detach from Parent", ru: "Отвязать от исходного" }),
    category: legacyBilingualLabel(CATEGORY_FILE),
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.documents.get(activeDocumentId)?.provenance),
    execute: ({ activeDocumentId }) => { if (activeDocumentId) kernel.roundtrip.detach(activeDocumentId); },
  });
  kernel.commands.register({ id: "layer.new", label: legacyBilingualLabel({ en: "New Layer", ru: "Новый слой" }), category: legacyBilingualLabel(CATEGORY_LAYER), shortcut: "Mod+Shift+N", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void changeRasterDocument(activeDocumentId, "New Layer (Новый слой)", (state) => { const layer = createRasterLayer(state.width, state.height, `Layer ${state.layers.length + 1} (Слой ${state.layers.length + 1})`); state.layers.push(layer); state.activeLayerId = layer.id; return true; }); } });
  kernel.commands.register({ id: "layer.new3DText", label: legacyBilingualLabel({ en: "New 3D Text Layer…", ru: "Новый объёмный текстовый слой…" }), category: legacyBilingualLabel(CATEGORY_3D), isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: ({ activeDocumentId }) => { if (activeDocumentId) void createScene3DTextLayer(activeDocumentId); } });
  kernel.commands.register({
    id: "layer.new3DExtrude",
    label: legacyBilingualLabel({ en: "New 3D Extrusion from Layer", ru: "Экструдировать слой в 3D" }),
    category: legacyBilingualLabel(CATEGORY_3D),
    isEnabled: ({ activeDocumentId }) => {
      const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
      return Boolean(document && isRasterDocumentState(document.state) && document.state.activeLayerId);
    },
    execute: ({ activeDocumentId }) => {
      const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
      if (!document || !isRasterDocumentState(document.state) || !document.state.activeLayerId) return;
      void createScene3DExtrudeLayer(activeDocumentId!, document.state.activeLayerId);
    },
  });
  // Photoshop's layer shortcuts, in its own order and with its own keys.
  const raster = ({ activeDocumentId }: { activeDocumentId?: string | null }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster";
  const editLayers = (documentId: string, label: string, mutate: (state: RasterDocumentState) => boolean) =>
    changeRasterDocument(documentId, label, mutate);

  kernel.commands.register({ id: "layer.duplicate", label: legacyBilingualLabel({ en: "Duplicate Layer", ru: "Создать дубликат слоя" }), category: legacyBilingualLabel(CATEGORY_LAYER), shortcut: "Mod+J", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const document = kernel.documents.get<RasterDocumentState>(activeDocumentId); if (!document) return; void editLayers(activeDocumentId, "Layer via Copy (Слой копированием)", (state) => Boolean(layerFromSelection(state, state.activeLayerId, state.selection, false))); } });
  kernel.commands.register({ id: "layer.delete", label: legacyBilingualLabel({ en: "Delete Layer", ru: "Удалить слой" }), category: legacyBilingualLabel(CATEGORY_LAYER), isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Delete Layer (Удалить слой)", (state) => removeLayer(state, state.activeLayerId)); } });
  kernel.commands.register({ id: "layer.viaCut", label: legacyBilingualLabel({ en: "Layer via Cut", ru: "Вырезать на новый слой" }), category: legacyBilingualLabel(CATEGORY_LAYER), shortcut: "Mod+Shift+J", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection), execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Layer via Cut (Слой вырезанием)", (state) => Boolean(layerFromSelection(state, state.activeLayerId, state.selection, true))); } });
  kernel.commands.register({ id: "layer.mergeDown", label: legacyBilingualLabel({ en: "Merge Down", ru: "Объединить с предыдущим" }), category: legacyBilingualLabel(CATEGORY_LAYER), shortcut: "Mod+E", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Merge Down (Объединить с предыдущим)", (state) => Boolean(mergeLayerDown(state, state.activeLayerId))); } });
  kernel.commands.register({ id: "layer.mergeVisible", label: legacyBilingualLabel({ en: "Merge Visible", ru: "Объединить видимые" }), category: legacyBilingualLabel(CATEGORY_LAYER), shortcut: "Mod+Shift+E", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Merge Visible (Объединить видимые)", (state) => Boolean(mergeVisibleLayers(state))); } });
  kernel.commands.register({ id: "layer.stampVisible", label: legacyBilingualLabel({ en: "Stamp Visible", ru: "Отпечаток видимых" }), category: legacyBilingualLabel(CATEGORY_LAYER), shortcut: "Mod+Shift+Alt+E", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Stamp Visible (Отпечаток видимых)", (state) => Boolean(stampVisibleLayers(state))); } });
  kernel.commands.register({ id: "layer.group", label: legacyBilingualLabel({ en: "Group Layers", ru: "Сгруппировать слои" }), category: legacyBilingualLabel(CATEGORY_LAYER), shortcut: "Mod+G", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const chosen = useShellStore.getState().selectedLayerIdsByDocument[activeDocumentId] ?? []; void editLayers(activeDocumentId, "Group Layers (Сгруппировать слои)", (state) => Boolean(groupLayers(state, chosen.length ? chosen : [state.activeLayerId]))); } });
  kernel.commands.register({ id: "layer.ungroup", label: legacyBilingualLabel({ en: "Ungroup Layers", ru: "Разгруппировать слои" }), category: legacyBilingualLabel(CATEGORY_LAYER), shortcut: "Mod+Shift+G", isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, "Ungroup Layers (Разгруппировать слои)", (state) => ungroupLayer(state, state.activeLayerId)); } });
  for (const [id, label, shortcut, move] of [
    ["layer.bringForward", "Bring Forward (Переложить вперёд)", "Mod+]", "up"],
    ["layer.sendBackward", "Send Backward (Переложить назад)", "Mod+[", "down"],
    ["layer.bringToFront", "Bring to Front (На передний план)", "Mod+Shift+]", "top"],
    ["layer.sendToBack", "Send to Back (На задний план)", "Mod+Shift+[", "bottom"],
  ] as const) {
    kernel.commands.register({ id, label, category: legacyBilingualLabel(CATEGORY_LAYER), shortcut, isEnabled: raster, execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; void editLayers(activeDocumentId, label, (state) => moveLayerInStack(state, state.activeLayerId, move)); } });
  }

  kernel.commands.register({ id: "edit.undo", label: legacyBilingualLabel({ en: "Undo", ru: "Отменить" }), category: legacyBilingualLabel(CATEGORY_EDIT), shortcut: "Mod+Z", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.historyByDocument.get(activeDocumentId)?.canUndo), execute: async ({ activeDocumentId }) => { if (activeDocumentId) await kernel.historyByDocument.get(activeDocumentId)?.undo(); } });
  kernel.commands.register({ id: "edit.redo", label: legacyBilingualLabel({ en: "Redo", ru: "Повторить" }), category: legacyBilingualLabel(CATEGORY_EDIT), shortcut: "Mod+Shift+Z", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.historyByDocument.get(activeDocumentId)?.canRedo), execute: async ({ activeDocumentId }) => { if (activeDocumentId) await kernel.historyByDocument.get(activeDocumentId)?.redo(); } });
  // Select All takes the whole canvas, as it does in Photoshop. Selecting the
  // layer's opaque pixels is a different operation and keeps its own entry.
  kernel.commands.register({ id: "select.all", label: legacyBilingualLabel({ en: "Select All", ru: "Выделить все" }), category: legacyBilingualLabel(CATEGORY_SELECT), shortcut: "Mod+A", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Select All (Выделить все)", (state) => selectAllPixels(state.width, state.height)); } });
  kernel.commands.register({ id: "select.opaque", label: legacyBilingualLabel({ en: "Select Layer Content", ru: "Выделить содержимое слоя" }), category: legacyBilingualLabel(CATEGORY_SELECT), isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Select Layer Content (Выделить содержимое слоя)", (state) => selectOpaquePixels(layerDocumentPixels(activeRasterLayer(state), state.width, state.height), state.width, state.height)); } });
  kernel.commands.register({ id: "select.none", label: legacyBilingualLabel({ en: "Deselect", ru: "Снять выделение" }), category: legacyBilingualLabel(CATEGORY_SELECT), shortcut: "Mod+D", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && isRasterDocumentState(kernel.documents.get(activeDocumentId)?.state) && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection), execute: async ({ activeDocumentId }) => { if (!activeDocumentId) return; const current = kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection; if (current) lastSelectionByDocument.set(activeDocumentId, { mask: current.mask.slice(), bounds: { ...current.bounds } }); await changeRasterSelection(activeDocumentId, "Deselect (Снять выделение)", () => null); } });
  kernel.commands.register({ id: "select.reselect", label: legacyBilingualLabel({ en: "Reselect", ru: "Выделить снова" }), category: legacyBilingualLabel(CATEGORY_SELECT), shortcut: "Mod+Shift+D", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && lastSelectionByDocument.has(activeDocumentId)), execute: async ({ activeDocumentId }) => { if (!activeDocumentId) return; const previous = lastSelectionByDocument.get(activeDocumentId); if (previous) await changeRasterSelection(activeDocumentId, "Reselect (Выделить снова)", () => ({ mask: previous.mask.slice(), bounds: { ...previous.bounds } })); } });
  kernel.commands.register({ id: "select.feather", label: legacyBilingualLabel({ en: "Feather Selection…", ru: "Растушевать выделение…" }), category: legacyBilingualLabel(CATEGORY_SELECT), shortcut: "Shift+F6", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection), execute: () => dispatch("vravio-select-feather") });
  kernel.commands.register({ id: "select.hideEdges", label: legacyBilingualLabel({ en: "Show/Hide Selection Edges", ru: "Показать/скрыть края выделения" }), category: legacyBilingualLabel(CATEGORY_VIEW), shortcut: "Mod+H", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: () => useShellStore.getState().toggleSelectionEdges() });
  kernel.commands.register({ id: "select.invert", label: legacyBilingualLabel({ en: "Invert Selection", ru: "Инвертировать выделение" }), category: legacyBilingualLabel(CATEGORY_SELECT), shortcut: "Mod+Shift+I", isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster", execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Invert Selection (Инвертировать выделение)", (state) => invertPixelSelection(state.selection, state.width, state.height)); } });
  kernel.commands.register({ id: "view.fit", label: legacyBilingualLabel({ en: "Fit on Screen", ru: "Подогнать по экрану" }), category: legacyBilingualLabel(CATEGORY_VIEW), shortcut: "Mod+0", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { mode: "fit", panX: 0, panY: 0 }); } });
  kernel.commands.register({ id: "view.actual", label: legacyBilingualLabel({ en: "Actual Size 100%", ru: "Реальный размер 100%" }), category: legacyBilingualLabel(CATEGORY_VIEW), shortcut: "Mod+1", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { mode: "actual", zoom: 1, panX: 0, panY: 0 }); } });
  kernel.commands.register({ id: "view.zoomIn", label: legacyBilingualLabel({ en: "Zoom In", ru: "Увеличить масштаб" }), category: legacyBilingualLabel(CATEGORY_VIEW), shortcut: "Mod++", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const current = useShellStore.getState().viewports[activeDocumentId]; useShellStore.getState().setViewport(activeDocumentId, { mode: "custom", zoom: Math.min(64, (current?.zoom ?? 1) * 1.25) }); } });
  kernel.commands.register({ id: "view.zoomOut", label: legacyBilingualLabel({ en: "Zoom Out", ru: "Уменьшить масштаб" }), category: legacyBilingualLabel(CATEGORY_VIEW), shortcut: "Mod+-", isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (!activeDocumentId) return; const current = useShellStore.getState().viewports[activeDocumentId]; useShellStore.getState().setViewport(activeDocumentId, { mode: "custom", zoom: Math.max(0.01, (current?.zoom ?? 1) / 1.25) }); } });
  kernel.commands.register({ id: "view.resetRotation", label: legacyBilingualLabel({ en: "Reset View Rotation", ru: "Сбросить вращение вида" }), category: legacyBilingualLabel(CATEGORY_VIEW), isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId), execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { rotation: 0 }); } });
  kernel.commands.register({ id: "view.theme", label: legacyBilingualLabel({ en: "Cycle Theme", ru: "Сменить тему" }), category: legacyBilingualLabel(CATEGORY_VIEW), execute: () => useShellStore.getState().cycleTheme() });
  kernel.commands.register({ id: "app.settings", label: legacyBilingualLabel({ en: "Settings", ru: "Настройки" }), category: legacyBilingualLabel(CATEGORY_EDIT), execute: () => useShellStore.getState().setSettingsOpen(true) });
  kernel.commands.register({ id: "view.commandPalette", label: legacyBilingualLabel({ en: "Search", ru: "Поиск" }), category: legacyBilingualLabel(CATEGORY_EDIT), shortcut: "Mod+F", execute: () => useShellStore.getState().setPaletteOpen(true) });
  kernel.commands.register({ id: "edit.freeTransform", label: legacyBilingualLabel({ en: "Free Transform", ru: "Свободная трансформация" }), category: legacyBilingualLabel(CATEGORY_EDIT), shortcut: "Mod+T", isEnabled: raster, execute: () => dispatch("vravio-transform-start") });
  kernel.commands.register({ id: "view.toggleRulers", label: legacyBilingualLabel({ en: "Rulers", ru: "Линейки" }), category: legacyBilingualLabel(CATEGORY_VIEW), shortcut: "Mod+R", execute: () => useShellStore.getState().updatePreferences({ showRulers: !useShellStore.getState().preferences.showRulers }) });
  kernel.commands.register({ id: "view.toggleGuides", label: legacyBilingualLabel({ en: "Guides", ru: "Направляющие" }), category: legacyBilingualLabel(CATEGORY_VIEW), shortcut: "Mod+;", execute: () => useShellStore.getState().updatePreferences({ showGuides: !useShellStore.getState().preferences.showGuides }) });
  kernel.commands.register({ id: "filter.liquify", label: legacyBilingualLabel({ en: "Liquify…", ru: "Пластика…" }), category: legacyBilingualLabel(CATEGORY_FILTER), shortcut: "Mod+Shift+X", isEnabled: raster, execute: () => dispatch("vravio-liquify-open") });
  const openAdjustment = (kind: string): void => { window.dispatchEvent(new CustomEvent("vravio-adjustment-open", { detail: { kind } })); };
  const adjustmentEnabled = ({ activeDocumentId }: { activeDocumentId?: string | null }) => { const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? ""); return Boolean(document && isRasterDocumentState(document.state) && document.state.layers.find((layer) => layer.id === document.state.activeLayerId)?.kind === "pixel"); };
  kernel.commands.register({ id: "image.adjustment.levels", label: legacyBilingualLabel({ en: "Levels…", ru: "Уровни…" }), category: legacyBilingualLabel(CATEGORY_IMAGE), shortcut: "Mod+L", isEnabled: adjustmentEnabled, execute: () => openAdjustment("levels") });
  kernel.commands.register({ id: "image.adjustment.curves", label: legacyBilingualLabel({ en: "Curves…", ru: "Кривые…" }), category: legacyBilingualLabel(CATEGORY_IMAGE), shortcut: "Mod+M", isEnabled: adjustmentEnabled, execute: () => openAdjustment("curves") });
  kernel.commands.register({ id: "image.adjustment.hueSaturation", label: legacyBilingualLabel({ en: "Hue/Saturation…", ru: "Цветовой тон/Насыщенность…" }), category: legacyBilingualLabel(CATEGORY_IMAGE), shortcut: "Mod+U", isEnabled: adjustmentEnabled, execute: () => openAdjustment("hueSaturation") });
  kernel.commands.register({ id: "image.adjustment.colorBalance", label: legacyBilingualLabel({ en: "Color Balance…", ru: "Цветовой баланс…" }), category: legacyBilingualLabel(CATEGORY_IMAGE), shortcut: "Mod+B", isEnabled: adjustmentEnabled, execute: () => openAdjustment("colorBalance") });
  kernel.commands.register({ id: "image.adjustment.invert", label: legacyBilingualLabel({ en: "Invert", ru: "Инвертировать" }), category: legacyBilingualLabel(CATEGORY_IMAGE), shortcut: "Mod+I", isEnabled: adjustmentEnabled, execute: () => openAdjustment("invert") });
  registerToolShortcuts();
  for (const command of kernel.commands.list()) if (command.shortcut) { rememberDefaultShortcut(command.id, command.shortcut); kernel.keymap.bind(command.id, command.shortcut, command.scope); }
  applyShortcutOverrides();
}

/**
 * One command per letter a tool's shortcut sits on, not one per tool.
 *
 * Photoshop's own convention: a plain letter always selects the first tool sharing it
 * (e.g. M is the Marquee), and Shift steps to the next one in the group, wrapping around.
 * Raster and vector each get their own scope, because both put a tool on some of the same
 * letters (V is Move in raster, Selection in vector) and only one document kind is active
 * at a time.
 */
function registerToolShortcuts(): void {
  const groups = new Map<string, typeof tools[number][]>();
  for (const tool of tools) {
    const key = `${tool.kind}:${tool.shortcut.toLocaleUpperCase()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(tool);
  }
  for (const [key, group] of groups) {
    const [kind, letter] = key.split(":") as [EnvironmentKind, string];
    kernel.commands.register({
      id: `tool.${kind}.${letter.toLocaleLowerCase()}`,
      // Each language's own names joined separately, then wrapped once — not
      // a join of already-combined "English (Русский)" strings, which used
      // to mangle both halves whenever a shortcut letter held more than one
      // tool (e.g. R for Blur/Smudge): localized()'s regex matches only the
      // *last* parenthesised pair in the joined string, so the Russian side
      // silently dropped every name but the last and the English side ended
      // up with a stray Russian fragment baked into it.
      label: legacyBilingualLabel({
        en: group.map((tool) => resolveLabel(tool.label, "en")).join(" / "),
        ru: group.map((tool) => resolveLabel(tool.label, "ru")).join(" / "),
      }),
      category: legacyBilingualLabel(CATEGORY_TOOLS),
      shortcut: letter,
      scope: kind,
      isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === kind,
      execute: ({ activeDocumentId, shiftKey }) => {
        if (!activeDocumentId) return;
        const current = useShellStore.getState().activeToolByDocument[activeDocumentId];
        const currentIndex = group.findIndex((tool) => tool.id === current);
        const tool = shiftKey && group.length > 1 ? group[(currentIndex + 1 + group.length) % group.length] : group[0];
        if (tool) useShellStore.getState().setTool(activeDocumentId, tool.id);
      },
    });
  }
}

export function activeCommandContext(): CommandContext {
  return { activeDocumentId: useShellStore.getState().activeDocumentId };
}
