import { activeRasterLayer, appendLayer, clearSelectedPixels, convertLayerToEmbeddedSmartObject, createRasterLayer, duplicateLayer, groupLayers, isEditableEmbeddedSmartObject, isRasterDocumentState, layerAccepts, layerDocumentPixels, layerFromSelection, makeIndependentEmbeddedSmartObjectCopy, mergeLayerDown, mergeVisibleLayers, moveLayerInStack, RASTER_ASSET_MIME, removeLayer, replaceSmartObjectSourcePixels, setLayerLocalPixels, setLayerPixels, stampVisibleLayers, ungroupLayer, encodeRasterAsset, type RasterDocumentState } from "@vravio/env-raster";
import type { AssetId, EnvironmentKind } from "@vravio/kernel";
import { kernel } from "../../../../kernel";
import { useShellStore } from "../../../../store";
import { CATEGORY_LAYER } from "../../../../commands/categories";
import { activeRasterState, isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";
import { confirmModal } from "../../../../modals/runtime";
import { text } from "../../../../i18n";
import { changeRasterDocument } from "../document-edits";
import { decodeImportedImage } from "../../../../imageImport";

/**
 * Photoshop's layer commands, in its own order and with its own keys.
 *
 * All of them appear in the layer panel's context menu as well as the Layer
 * menu — right-clicking a layer and reaching for the menu bar should offer the
 * same things, which is the disagreement `surfaces` exists to prevent.
 */

/** Opens the active layer as a document of its own and links the two.
 *
 * The layer's pixels become an asset that both documents point at, so applying
 * from the child sends a revision back and the parent picks it up. Nothing in
 * this command knows how that happens; that is the kernel's round-trip
 * manager's business, and the same command will open a layer in the vector or
 * 3D environment once those exist. */
async function openTargetElsewhere(documentId: string, targetEnv: EnvironmentKind, branch: boolean): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const layer = activeRasterLayer(document.state);
  if (!layer) return;

  const session = await kernel.roundtrip.open({ parentDocId: documentId, target: { kind: "raster-layer", layerId: layer.id }, targetEnv, branch });
  useShellStore.getState().adoptDocument(session.childDocId);
}

/**
 * The source is imported once into the document asset store, then history
 * records only the structural switch. This keeps the Smart Object small,
 * reversible, and on the same asset-revision route as Edit Contents.
 */
async function convertActiveLayerToSmartObject(documentId: string): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const layer = activeRasterLayer(document.state);
  if (layer.kind !== "pixel") return;

  const raster = kernel.environments.get("raster");
  const extracted = await raster.extractAsset(document, { kind: "raster-layer", layerId: layer.id }, { handles: 0, forceNew: true });
  await edit(documentId, "Convert to Smart Object (Преобразовать в смарт-объект)", (state) => {
    const target = state.layers.find((item) => item.id === layer.id);
    return Boolean(target && convertLayerToEmbeddedSmartObject(target, extracted.assetId));
  });
  kernel.documents.addAssetRef(documentId, extracted.assetId);
}

async function editActiveSmartObjectContents(documentId: string): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  if (!isEditableEmbeddedSmartObject(activeRasterLayer(document.state))) return;
  await openTargetElsewhere(documentId, "raster", false);
}

/** Photoshop's New Smart Object via Copy: same visual pixels, separate source. */
async function createIndependentSmartObjectCopy(documentId: string): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const source = activeRasterLayer(document.state);
  if (!isEditableEmbeddedSmartObject(source)) return;
  const assetId = source.smartSource!.assetId as AssetId;
  const record = kernel.assets.mustGet(assetId);
  const bytes = await kernel.assets.read(assetId);
  if (!bytes) return;
  // AssetStore correctly deduplicates ordinary identical imports. A Smart
  // Object via Copy must intentionally *not* deduplicate: its source is now
  // independently editable, so an opaque copy token makes that semantic
  // distinction durable through persistence and reload.
  const copyAssetId = await kernel.assets.importAsset(bytes, {
    kind: record.kind,
    mime: record.mime,
    name: record.name,
    producedBy: "smart-object",
    meta: { ...record.meta, smartObjectCopyOf: assetId, smartObjectCopyNonce: crypto.randomUUID() },
  });
  await edit(documentId, "New Smart Object via Copy (Новый смарт-объект через копирование)", (state) => {
    const copy = duplicateLayer(state, source.id);
    return Boolean(copy && makeIndependentEmbeddedSmartObjectCopy(copy, copyAssetId));
  });
  kernel.documents.addAssetRef(documentId, copyAssetId);
}

/** Reads one user-picked image into the same internal raster asset format that
 * round-trip and embedded Smart Objects already use. `Platform.fs` gives the
 * desktop native picker and the web picker one identical command path. */
async function pickEmbeddedSmartObjectSource(): Promise<{ assetId: AssetId; pixels: Uint8ClampedArray; width: number; height: number; name: string; linkedPath: string | null } | null> {
  const selected = await kernel.platform.fs.openFiles({ accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".tif", ".tiff", ".svg"] } });
  const picked = selected[0]; if (!picked) return null;
  const bytes = new Uint8Array(picked.data.byteLength); bytes.set(picked.data);
  const file = new File([bytes.buffer], picked.name, { type: picked.mime || "image/png" });
  const decoded = await decodeImportedImage(file); if (!decoded) return null;
  try {
    const surface = window.document.createElement("canvas");
    surface.width = decoded.width; surface.height = decoded.height;
    const context = surface.getContext("2d"); if (!context) return null;
    context.drawImage(decoded.image, 0, 0);
    const pixels = new Uint8ClampedArray(context.getImageData(0, 0, decoded.width, decoded.height).data);
    const assetId = await kernel.assets.importAsset(encodeRasterAsset(pixels, decoded.width, decoded.height), {
      kind: "image", mime: RASTER_ASSET_MIME, name: picked.name, producedBy: "smart-object",
    });
    return { assetId, pixels, width: decoded.width, height: decoded.height, name: picked.name, linkedPath: picked.path ?? null };
  } finally { decoded.release(); }
}

/** Place Linked is intentionally desktop-only for now: a browser File cannot
 * persist a usable absolute path after reload, so advertising it as a linked
 * asset would be a broken promise. The asset preview still lives in the
 * document, while `linkedPath` is the authoritative source to refresh later. */
async function placeLinkedSmartObject(documentId: string): Promise<void> {
  if (kernel.platform.kind !== "desktop") return;
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const source = await pickEmbeddedSmartObjectSource();
  const linkedPath = source?.linkedPath;
  if (!source || !linkedPath) return;
  await edit(documentId, "Place Linked Smart Object (Поместить связанный смарт-объект)", (state) => {
    const layer = createRasterLayer(1, 1, source.name.replace(/\.[^.]+$/, "") || source.name);
    const x = Math.round((state.width - source.width) / 2), y = Math.round((state.height - source.height) / 2);
    setLayerLocalPixels(layer, source.pixels, { x, y, width: source.width, height: source.height });
    if (!convertLayerToEmbeddedSmartObject(layer, source.assetId)) return false;
    layer.smartSource = { ...layer.smartSource!, mode: "linked", linkedPath };
    appendLayer(state, layer); state.activeLayerId = layer.id;
    return true;
  });
  kernel.documents.addAssetRef(documentId, source.assetId);
}

/** Photoshop's Replace Contents: only the selected placement gets a new source;
 * regular duplicates continue following their previous shared asset. */
async function replaceActiveSmartObjectContents(documentId: string): Promise<void> {
  const document = kernel.documents.get<RasterDocumentState>(documentId);
  if (!document || !isRasterDocumentState(document.state)) return;
  const selected = activeRasterLayer(document.state); if (!selected || !isEditableEmbeddedSmartObject(selected)) return;
  const source = await pickEmbeddedSmartObjectSource(); if (!source) return;
  await edit(documentId, "Replace Smart Object Contents (Заменить содержимое смарт-объекта)", (state) => {
    const layer = state.layers.find((item) => item.id === selected.id);
    if (!layer || !isEditableEmbeddedSmartObject(layer)) return false;
    layer.pixelAssetId = source.assetId;
    layer.smartSource = { ...layer.smartSource!, assetId: source.assetId, pinnedRev: null, mode: "embedded" };
    return replaceSmartObjectSourcePixels(layer, source.pixels, source.width, source.height);
  });
  kernel.documents.addAssetRef(documentId, source.assetId);
}

const edit = (documentId: string, label: string, mutate: (state: RasterDocumentState) => boolean) => changeRasterDocument(documentId, label, mutate);

/** The four restacking commands differ only by where the layer lands. */
const restack = ([id, en, ru, shortcut, move]: readonly [string, string, string, string, "up" | "down" | "top" | "bottom"]): CommandDefinition => ({
  id,
  label: { en, ru },
  category: CATEGORY_LAYER,
  shortcut,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  // The history label keeps the concatenated shape it had, because that is
  // what the history panel shows and it is not a catalogue definition field.
  execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, `${en} (${ru})`, (state) => moveLayerInStack(state, state.activeLayerId, move)); },
});

const commands: readonly CommandDefinition[] = [
  {
    id: "layer.new",
    label: { en: "New Layer", ru: "Новый слой" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+Shift+N",
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => {
      if (!activeDocumentId) return;
      void edit(activeDocumentId, "New Layer (Новый слой)", (state) => {
        const layer = createRasterLayer(state.width, state.height, `Layer ${state.layers.length + 1} (Слой ${state.layers.length + 1})`);
        state.layers.push(layer);
        state.activeLayerId = layer.id;
        return true;
      });
    },
  },
  {
    id: "layer.duplicate",
    label: { en: "Duplicate Layer", ru: "Создать дубликат слоя" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+J",
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => {
      if (!activeDocumentId || !kernel.documents.get<RasterDocumentState>(activeDocumentId)) return;
      void edit(activeDocumentId, "Layer via Copy (Слой копированием)", (state) => Boolean(layerFromSelection(state, state.activeLayerId, state.selection, false)));
    },
  },
  {
    id: "layer.delete",
    label: { en: "Delete Layer", ru: "Удалить слой" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette"],
    // Not on "layer-context": the layer panel's own Delete also retargets mask
    // editing and moves the panel selection to the survivor, which this command
    // does not do yet. The panel keeps supplying that entry until it does —
    // named here rather than left as a silent difference between two Deletes.
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, "Delete Layer (Удалить слой)", (state) => removeLayer(state, state.activeLayerId)); },
  },
  {
    id: "layer.clear",
    label: { en: "Clear Layer / Selection", ru: "Очистить слой / выделение" },
    category: CATEGORY_LAYER,
    // Windows keyboards only, deliberately: Patchy binds Backspace as well, but
    // only on macOS, where the key labelled Delete sends Backspace. The
    // catalogue carries one shortcut per command, and on this platform that one
    // is Delete.
    shortcut: "Delete",
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: async ({ activeDocumentId }) => {
      const state = activeRasterState(activeDocumentId);
      if (!state || !activeDocumentId) return;
      // A mask being edited owns Delete already (the layer panel's own handler,
      // with its own confirmation) — and both listeners see the same keydown, so
      // without this the two would fire together on one keypress.
      if (useShellStore.getState().editingMaskLayerIdByDocument[activeDocumentId]) return;

      // With a selection, Delete clears the selected pixels and the layer stays
      // — Photoshop's behaviour, and Patchy's `layer.clear` (main_window_layer_ops.cpp).
      if (state.selection) {
        const selection = state.selection;
        await edit(activeDocumentId, "Clear Selection (Очистить выделение)", (draft) => {
          const layer = draft.layers.find((item) => item.id === draft.activeLayerId);
          if (!layer || layer.kind === "group" || !layerAccepts(layer, "paint")) return false;
          setLayerPixels(layer, clearSelectedPixels(layerDocumentPixels(layer, draft.width, draft.height), draft.width, draft.height, selection), draft.width, draft.height);
          return true;
        });
        return;
      }

      // With nothing selected, Delete removes the layer itself, which is what
      // the owner asked for — behind the same confirmation the layer panel puts
      // in front of deleting a mask, since a keypress that silently discards a
      // whole layer is the one outcome with no visual warning at all.
      const language = useShellStore.getState().language;
      const confirmed = await confirmModal({
        title: text(language, "Delete Layer", "Удалить слой"),
        message: text(language, "Delete this layer?", "Удалить этот слой?"),
        confirmLabel: text(language, "Delete", "Удалить"),
        danger: true,
        confirmKey: "delete-layer",
      });
      if (!confirmed) return;
      await edit(activeDocumentId, "Delete Layer (Удалить слой)", (draft) => removeLayer(draft, draft.activeLayerId));
    },
  },
  {
    id: "layer.viaCut",
    label: { en: "Layer via Cut", ru: "Вырезать на новый слой" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+Shift+J",
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection),
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, "Layer via Cut (Слой вырезанием)", (state) => Boolean(layerFromSelection(state, state.activeLayerId, state.selection, true))); },
  },
  {
    id: "layer.mergeDown",
    label: { en: "Merge Down", ru: "Объединить с предыдущим" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+E",
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, "Merge Down (Объединить с предыдущим)", (state) => Boolean(mergeLayerDown(state, state.activeLayerId))); },
  },
  {
    id: "layer.mergeVisible",
    label: { en: "Merge Visible", ru: "Объединить видимые" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+Shift+E",
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, "Merge Visible (Объединить видимые)", (state) => Boolean(mergeVisibleLayers(state))); },
  },
  {
    id: "layer.stampVisible",
    label: { en: "Stamp Visible", ru: "Отпечаток видимых" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+Shift+Alt+E",
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, "Stamp Visible (Отпечаток видимых)", (state) => Boolean(stampVisibleLayers(state))); },
  },
  {
    id: "layer.toggleClippingMask",
    label: { en: "Create/Release Clipping Mask", ru: "Создать/освободить обтравочную маску" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+Alt+G",
    surfaces: ["menu", "palette"],
    // master-plan.md §1.9 item 9 (merged with item 14): Photoshop's own
    // Ctrl+Alt+G, on top of the two direct gestures already covered
    // elsewhere — the layer panel's own toggle button, and the Ctrl-click
    // between two layer rows in DockLayout.tsx's LayersPanel, which now
    // calls this same command instead of duplicating the toggle logic
    // (the "единственная дверь" CLAUDE.md §4 asks for — one place decides
    // what clipping a layer means, not two that could drift).
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => {
      if (!activeDocumentId) return;
      void edit(activeDocumentId, "Toggle Clipping Mask (Обтравочная маска)", (state) => {
        const layer = state.layers.find((item) => item.id === state.activeLayerId);
        if (!layer || layer.kind === "group") return false;
        layer.clipping = !layer.clipping;
        return true;
      });
    },
  },
  {
    id: "layer.group",
    label: { en: "Group Layers", ru: "Сгруппировать слои" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+G",
    surfaces: ["menu", "palette"],
    // Not on "layer-context" for the same reason as `layer.delete`: the panel's
    // own Group selects the group it just made, and this command does not.
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => {
      if (!activeDocumentId) return;
      // Grouping acts on the panel's multi-selection when there is one, and on
      // the active layer alone when there is not.
      const chosen = useShellStore.getState().selectedLayerIdsByDocument[activeDocumentId] ?? [];
      void edit(activeDocumentId, "Group Layers (Сгруппировать слои)", (state) => Boolean(groupLayers(state, chosen.length ? chosen : [state.activeLayerId])));
    },
  },
  {
    id: "layer.ungroup",
    label: { en: "Ungroup Layers", ru: "Разгруппировать слои" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+Shift+G",
    surfaces: ["menu", "palette", "layer-context"],
    // Only a group can be ungrouped. The layer panel's own right-click menu
    // knew that and greyed the entry out; the command did not, so the palette
    // offered it on any layer and it quietly did nothing. Now that the menu is
    // generated from the command, the command is where the knowledge belongs.
    isEnabled: ({ activeDocumentId }) => {
      const state = activeRasterState(activeDocumentId);
      return Boolean(state && state.layers.find((layer) => layer.id === state.activeLayerId)?.kind === "group");
    },
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, "Ungroup Layers (Разгруппировать слои)", (state) => ungroupLayer(state, state.activeLayerId)); },
  },
  restack(["layer.bringForward", "Bring Forward", "Переложить вперёд", "Mod+]", "up"]),
  restack(["layer.sendBackward", "Send Backward", "Переложить назад", "Mod+[", "down"]),
  restack(["layer.bringToFront", "Bring to Front", "На передний план", "Mod+Shift+]", "top"]),
  restack(["layer.sendToBack", "Send to Back", "На задний план", "Mod+Shift+[", "bottom"]),
  {
    id: "layer.newSmartObjectViaCopy",
    label: { en: "New Smart Object via Copy", ru: "Новый смарт-объект через копирование" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: ({ activeDocumentId }) => {
      const state = activeRasterState(activeDocumentId);
      const layer = state?.layers.find((item) => item.id === state.activeLayerId);
      return Boolean(layer && isEditableEmbeddedSmartObject(layer));
    },
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void createIndependentSmartObjectCopy(activeDocumentId); },
  },
  {
    id: "layer.convertToSmartObject",
    label: { en: "Convert to Smart Object", ru: "Преобразовать в смарт-объект" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: ({ activeDocumentId }) => {
      const state = activeRasterState(activeDocumentId);
      return Boolean(state && state.layers.find((layer) => layer.id === state.activeLayerId)?.kind === "pixel");
    },
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void convertActiveLayerToSmartObject(activeDocumentId); },
  },
  {
    id: "layer.placeLinkedSmartObject",
    label: { en: "Place Linked…", ru: "Поместить связанный…" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.platform.kind === "desktop" && isRasterActive({ activeDocumentId })),
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void placeLinkedSmartObject(activeDocumentId); },
  },
  {
    id: "layer.editSmartObjectContents",
    label: { en: "Edit Contents", ru: "Редактировать содержимое" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: ({ activeDocumentId }) => {
      const state = activeRasterState(activeDocumentId);
      const layer = state?.layers.find((item) => item.id === state.activeLayerId);
      return Boolean(layer && isEditableEmbeddedSmartObject(layer));
    },
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void editActiveSmartObjectContents(activeDocumentId); },
  },
  {
    id: "layer.replaceSmartObjectContents",
    label: { en: "Replace Contents…", ru: "Заменить содержимое…" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: ({ activeDocumentId }) => {
      const state = activeRasterState(activeDocumentId);
      const layer = state?.layers.find((item) => item.id === state.activeLayerId);
      return Boolean(layer && isEditableEmbeddedSmartObject(layer));
    },
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void replaceActiveSmartObjectContents(activeDocumentId); },
  },
  {
    id: "layer.openElsewhere",
    label: { en: "Edit Layer in Its Own Tab", ru: "Открыть слой в отдельной вкладке" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openTargetElsewhere(activeDocumentId, "raster", false); },
  },
  {
    id: "layer.openElsewhereBranch",
    label: { en: "Edit Layer as a Copy", ru: "Открыть слой копией" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openTargetElsewhere(activeDocumentId, "raster", true); },
  },
];

export default commands;
