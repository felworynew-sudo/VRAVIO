import { activeRasterLayer, clearSelectedPixels, createRasterLayer, groupLayers, isRasterDocumentState, layerAccepts, layerDocumentPixels, layerFromSelection, mergeLayerDown, mergeVisibleLayers, moveLayerInStack, removeLayer, setLayerPixels, stampVisibleLayers, ungroupLayer, type RasterDocumentState } from "@vravio/env-raster";
import type { EnvironmentKind } from "@vravio/kernel";
import { kernel } from "../../../../kernel";
import { useShellStore } from "../../../../store";
import { CATEGORY_LAYER } from "../../../../commands/categories";
import { activeRasterState, isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";
import { confirmModal } from "../../../../modals/runtime";
import { text } from "../../../../i18n";
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
