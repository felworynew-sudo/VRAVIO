import { activeRasterLayer, invertPixelSelection, isRasterDocumentState, layerDocumentPixels, selectAllPixels, selectOpaquePixels, type PixelSelection, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "../../../../kernel";
import { useShellStore } from "../../../../store";
import { CATEGORY_SELECT, CATEGORY_VIEW } from "../../../../commands/categories";
import { dispatch, isRasterActive, hasActiveDocument } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";
import { changeRasterSelection } from "../document-edits";

/**
 * The selection commands.
 *
 * `select.hideEdges` is filed under View rather than Select, as it is in
 * Photoshop: it changes what is drawn, not what is selected.
 */

/** The selection each document last had, so Reselect has something to restore. */
const lastSelectionByDocument = new Map<string, PixelSelection>();

const commands: readonly CommandDefinition[] = [
  {
    // Select All takes the whole canvas, as it does in Photoshop. Selecting the
    // layer's opaque pixels is a different operation and keeps its own entry.
    id: "select.all",
    label: { en: "Select All", ru: "Выделить все" },
    category: CATEGORY_SELECT,
    shortcut: "Mod+A",
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Select All (Выделить все)", (state) => selectAllPixels(state.width, state.height)); },
  },
  {
    id: "select.opaque",
    label: { en: "Select Layer Content", ru: "Выделить содержимое слоя" },
    category: CATEGORY_SELECT,
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Select Layer Content (Выделить содержимое слоя)", (state) => selectOpaquePixels(layerDocumentPixels(activeRasterLayer(state), state.width, state.height), state.width, state.height)); },
  },
  {
    id: "select.none",
    label: { en: "Deselect", ru: "Снять выделение" },
    category: CATEGORY_SELECT,
    shortcut: "Mod+D",
    surfaces: ["menu", "palette", "canvas-context"],
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && isRasterDocumentState(kernel.documents.get(activeDocumentId)?.state) && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection),
    execute: async ({ activeDocumentId }) => {
      if (!activeDocumentId) return;
      // Remembered before it is dropped: Reselect has nothing to restore
      // otherwise, and undo is not the same gesture.
      const current = kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection;
      if (current) lastSelectionByDocument.set(activeDocumentId, { mask: current.mask.slice(), bounds: { ...current.bounds } });
      await changeRasterSelection(activeDocumentId, "Deselect (Снять выделение)", () => null);
    },
  },
  {
    id: "select.reselect",
    label: { en: "Reselect", ru: "Выделить снова" },
    category: CATEGORY_SELECT,
    shortcut: "Mod+Shift+D",
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && lastSelectionByDocument.has(activeDocumentId)),
    execute: async ({ activeDocumentId }) => {
      if (!activeDocumentId) return;
      const previous = lastSelectionByDocument.get(activeDocumentId);
      if (previous) await changeRasterSelection(activeDocumentId, "Reselect (Выделить снова)", () => ({ mask: previous.mask.slice(), bounds: { ...previous.bounds } }));
    },
  },
  {
    id: "select.invert",
    label: { en: "Invert Selection", ru: "Инвертировать выделение" },
    category: CATEGORY_SELECT,
    shortcut: "Mod+Shift+I",
    surfaces: ["menu", "palette", "canvas-context"],
    isEnabled: isRasterActive,
    execute: async ({ activeDocumentId }) => { if (activeDocumentId) await changeRasterSelection(activeDocumentId, "Invert Selection (Инвертировать выделение)", (state) => invertPixelSelection(state.selection, state.width, state.height)); },
  },
  {
    id: "select.feather",
    label: { en: "Feather Selection…", ru: "Растушевать выделение…" },
    category: CATEGORY_SELECT,
    shortcut: "Shift+F6",
    surfaces: ["menu", "palette", "canvas-context"],
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection),
    execute: () => dispatch("vravio-select-feather"),
  },
  {
    id: "select.hideEdges",
    label: { en: "Show/Hide Selection Edges", ru: "Показать/скрыть края выделения" },
    category: CATEGORY_VIEW,
    shortcut: "Mod+H",
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: () => useShellStore.getState().toggleSelectionEdges(),
  },
];

export default commands;
