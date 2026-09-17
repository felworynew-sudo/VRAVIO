import { createRasterLayerMask, createRasterLayerMaskFromSelection } from "@vravio/env-raster";
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
];

export default commands;
