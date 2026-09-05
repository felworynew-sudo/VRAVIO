import { activeRasterLayer, createRasterLayer, groupLayers, isRasterDocumentState, layerFromSelection, mergeLayerDown, mergeVisibleLayers, moveLayerInStack, removeLayer, stampVisibleLayers, ungroupLayer, type RasterDocumentState } from "@vravio/env-raster";
import type { EnvironmentKind } from "@vravio/kernel";
import { kernel } from "../../../../kernel";
import { useShellStore } from "../../../../store";
import { CATEGORY_LAYER } from "../../../../commands/categories";
import { isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";
import { changeRasterDocument } from "../document-edits";

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

const edit = (documentId: string, label: string, mutate: (state: RasterDocumentState) => boolean) => changeRasterDocument(documentId, label, mutate);

/** The four restacking commands differ only by where the layer lands. */
const restack = ([id, en, ru, shortcut, move]: readonly [string, string, string, string, "up" | "down" | "top" | "bottom"]): CommandDefinition => ({
  id,
  label: { en, ru },
  category: CATEGORY_LAYER,
  shortcut,
  surfaces: ["menu", "palette", "layer-context"],
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
    surfaces: ["menu", "palette", "layer-context"],
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
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, "Delete Layer (Удалить слой)", (state) => removeLayer(state, state.activeLayerId)); },
  },
  {
    id: "layer.viaCut",
    label: { en: "Layer via Cut", ru: "Вырезать на новый слой" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+Shift+J",
    surfaces: ["menu", "palette", "layer-context"],
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
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, "Stamp Visible (Отпечаток видимых)", (state) => Boolean(stampVisibleLayers(state))); },
  },
  {
    id: "layer.group",
    label: { en: "Group Layers", ru: "Сгруппировать слои" },
    category: CATEGORY_LAYER,
    shortcut: "Mod+G",
    surfaces: ["menu", "palette", "layer-context"],
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
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void edit(activeDocumentId, "Ungroup Layers (Разгруппировать слои)", (state) => ungroupLayer(state, state.activeLayerId)); },
  },
  restack(["layer.bringForward", "Bring Forward", "Переложить вперёд", "Mod+]", "up"]),
  restack(["layer.sendBackward", "Send Backward", "Переложить назад", "Mod+[", "down"]),
  restack(["layer.bringToFront", "Bring to Front", "На передний план", "Mod+Shift+]", "top"]),
  restack(["layer.sendToBack", "Send to Back", "На задний план", "Mod+Shift+[", "bottom"]),
  {
    id: "layer.openElsewhere",
    label: { en: "Edit Layer in Its Own Tab", ru: "Открыть слой в отдельной вкладке" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openTargetElsewhere(activeDocumentId, "raster", false); },
  },
  {
    id: "layer.openElsewhereBranch",
    label: { en: "Edit Layer as a Copy", ru: "Открыть слой копией" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette", "layer-context"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openTargetElsewhere(activeDocumentId, "raster", true); },
  },
];

export default commands;
