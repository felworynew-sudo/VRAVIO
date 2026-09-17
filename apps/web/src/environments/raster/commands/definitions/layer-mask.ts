import { createRasterLayerMask, createRasterLayerMaskFromSelection, layerDocumentPixels, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import { useShellStore } from "../../../../store";
import { CATEGORY_LAYER } from "../../../../commands/categories";
import { activeRasterState } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";
import { changeRasterDocument, changeRasterSelection } from "../document-edits";

/**
 * Add Layer Mask as a command.
 *
 * It used to exist only as a local `addMask` closure inside the Layers panel
 * (`DockLayout.tsx`) — reachable from exactly one button. The Contextual Task
 * Bar's "Create mask" (master-plan §11, Photoshop's own "Create mask from
 * selection" on an active selection) needs the same operation, and a second
 * copy of it there would be the duplicate CLAUDE.md §4 warns about: two places
 * deciding what "add a mask with a selection active" means. So the logic moved
 * here, and the panel button now calls this command.
 *
 * master-plan.md §1.9 item 2: an active pixel selection becomes the new mask's
 * shape (white inside, black outside) instead of just vanishing — Photoshop's
 * own "Add Layer Mask with a selection active" behaviour. The selection is
 * cleared afterward: the shape now lives in the mask, and leaving the marching
 * ants up over it would say two things at once about what is "selected".
 */
/**
 * The layer a mask command acts on: the mask being edited (clicked mask
 * thumbnail) when there is one, otherwise the active layer — Photoshop's own
 * Layer ▸ Layer Mask entries target the active layer's mask the same way.
 */
function maskTargetId(documentId: string | null | undefined): string | null {
  const state = activeRasterState(documentId);
  if (!state || !documentId) return null;
  const editing = useShellStore.getState().editingMaskLayerIdByDocument[documentId];
  const id = editing && state.layers.some((layer) => layer.id === editing) ? editing : state.activeLayerId;
  const layer = state.layers.find((item) => item.id === id);
  return layer && layer.kind !== "group" && layer.mask ? layer.id : null;
}

const hasMaskTarget = ({ activeDocumentId }: { activeDocumentId?: string | null }) => maskTargetId(activeDocumentId) !== null;

const maskTargetIsEnabled = (documentId: string | null | undefined): boolean => {
  const id = maskTargetId(documentId);
  return Boolean(id && activeRasterState(documentId)?.layers.find((layer) => layer.id === id)?.mask?.enabled);
};

/** Stops editing a mask that no longer exists, so brushes go back to the layer's pixels. */
const leaveMask = (documentId: string, layerId: string): void => {
  if (useShellStore.getState().editingMaskLayerIdByDocument[documentId] === layerId) useShellStore.getState().setEditingMask(documentId, null);
};

/**
 * master-plan.md §19.1's P0 "Apply Mask": bakes the mask's coverage into the
 * layer's own alpha (`alpha *= maskValue/255 * density` — the exact formula the
 * compositor already uses, `render.ts`'s `maskAlpha`) and removes the mask.
 * Goes through `layerDocumentPixels` because `mask.tiles` is always
 * document-sized but `layer.tiles` is trimmed to the layer's own bounds —
 * `setLayerPixels` re-trims the result afterward. Moved here verbatim from the
 * Layers panel's `applyMask` closure (Contextual Task Bar, master-plan §11).
 */
function applyMaskTo(state: RasterDocumentState, layerId: string): boolean {
  const target = state.layers.find((item) => item.id === layerId);
  if (!target || target.kind === "group" || !target.mask) return false;
  const mask = target.mask;
  const pixels = layerDocumentPixels(target, state.width, state.height).slice();
  const maskPixels = mask.tiles.toPixels();
  for (let index = 0; index < maskPixels.length; index += 1) {
    const alpha = (maskPixels[index]! / 255) * mask.density, offset = index * 4 + 3;
    pixels[offset] = Math.round(pixels[offset]! * alpha);
  }
  setLayerPixels(target, pixels, state.width, state.height, null, { keepOutsideDocument: true });
  delete target.mask;
  return true;
}

const commands: readonly CommandDefinition[] = [
  {
    id: "layer.addMask",
    label: { en: "Add Layer Mask", ru: "Добавить маску слоя" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => {
      const state = activeRasterState(activeDocumentId);
      const layer = state?.layers.find((item) => item.id === state.activeLayerId);
      return Boolean(layer && layer.kind !== "group" && !layer.mask);
    },
    execute: async ({ activeDocumentId }) => {
      if (!activeDocumentId) return;
      let targetId: string | null = null, consumedSelection = false;
      // `changeRasterDocument`'s own history snapshot only carries
      // `layers`/`activeLayerId` (layer edits and selection edits are
      // deliberately "the two ways" a raster document changes, each with its
      // own undo) — setting `current.selection` inside it would silently vanish
      // on commit. Clearing the selection is therefore a second, separate
      // `changeRasterSelection` call, after this one has read it into the mask.
      await changeRasterDocument(activeDocumentId, "Add Layer Mask (Добавить маску слоя)", (current) => {
        const layer = current.layers.find((item) => item.id === current.activeLayerId);
        if (!layer || layer.kind === "group" || layer.mask) return false;
        layer.mask = current.selection ? createRasterLayerMaskFromSelection(current.selection, current.width, current.height) : createRasterLayerMask(current.width, current.height);
        consumedSelection = Boolean(current.selection);
        targetId = layer.id;
        return true;
      });
      if (consumedSelection) await changeRasterSelection(activeDocumentId, "Add Layer Mask (Добавить маску слоя)", () => null);
      if (targetId) useShellStore.getState().setEditingMask(activeDocumentId, targetId);
    },
  },
  {
    // Photoshop: Layer ▸ Layer Mask ▸ Disable / Enable (Shift-click on the
    // mask thumbnail). `mask.enabled` has always been honoured by the
    // compositor (`render.ts`); nothing in the UI could set it until now.
    id: "layer.toggleMaskEnabled",
    label: { en: "Disable/Enable Layer Mask", ru: "Выключить/включить маску слоя" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette"],
    isEnabled: hasMaskTarget,
    execute: async ({ activeDocumentId }) => {
      const id = maskTargetId(activeDocumentId);
      if (!activeDocumentId || !id) return;
      const label = maskTargetIsEnabled(activeDocumentId) ? "Disable Layer Mask (Выключить маску слоя)" : "Enable Layer Mask (Включить маску слоя)";
      await changeRasterDocument(activeDocumentId, label, (current) => {
        const layer = current.layers.find((item) => item.id === id);
        if (!layer || layer.kind === "group" || !layer.mask) return false;
        layer.mask.enabled = !layer.mask.enabled;
        return true;
      });
    },
  },
  {
    id: "layer.deleteMask",
    label: { en: "Delete Layer Mask", ru: "Удалить маску слоя" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette"],
    isEnabled: hasMaskTarget,
    execute: async ({ activeDocumentId }) => {
      const id = maskTargetId(activeDocumentId);
      if (!activeDocumentId || !id) return;
      await changeRasterDocument(activeDocumentId, "Delete Layer Mask (Удалить маску слоя)", (current) => {
        const layer = current.layers.find((item) => item.id === id);
        if (!layer || layer.kind === "group" || !layer.mask) return false;
        delete layer.mask;
        return true;
      });
      leaveMask(activeDocumentId, id);
    },
  },
  {
    id: "layer.applyMask",
    label: { en: "Apply Layer Mask", ru: "Применить маску слоя" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette"],
    isEnabled: hasMaskTarget,
    execute: async ({ activeDocumentId }) => {
      const id = maskTargetId(activeDocumentId);
      if (!activeDocumentId || !id) return;
      await changeRasterDocument(activeDocumentId, "Apply Layer Mask (Применить маску слоя)", (current) => applyMaskTo(current, id));
      leaveMask(activeDocumentId, id);
    },
  },
];

export default commands;
