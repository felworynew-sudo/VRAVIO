import { activeRasterLayer, contractSelection, expandSelection, featherSelection, invertPixelSelection, isRasterDocumentState, layerDocumentPixels, selectAllPixels, selectOpaquePixels, smoothSelection, type PixelSelection, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "../../../../kernel";
import { useShellStore } from "../../../../store";
import { CATEGORY_SELECT, CATEGORY_VIEW } from "../../../../commands/categories";
import { isRasterActive, hasActiveDocument } from "../../../../commands/shared";
import { selectModifyModal } from "../../../../modals/runtime";
import { startTransformSelection } from "../../../../transform-selection/session";
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

/** True while the active raster document has a selection to modify. */
const hasSelection = ({ activeDocumentId }: { activeDocumentId?: string | null }) =>
  Boolean(activeDocumentId && kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection);

type Modify = "feather" | "expand" | "contract" | "smooth";

/** The last answer per dialog, the way Photoshop reopens each with what was typed before. */
const lastModify: Record<Modify, { amount: number; applyAtCanvasBounds: boolean }> = {
  feather: { amount: 5, applyAtCanvasBounds: false },
  expand: { amount: 5, applyAtCanvasBounds: false },
  contract: { amount: 5, applyAtCanvasBounds: false },
  smooth: { amount: 5, applyAtCanvasBounds: false },
};

/**
 * Select ▸ Modify: ask for the amount, then replace the selection with the
 * engine's answer as one undoable step. Feather used to dispatch a
 * `vravio-select-feather` event that nothing listened to — the menu item did
 * nothing at all (found through the Contextual Task Bar, which offers it);
 * it now goes through the same dialog as its siblings.
 */
function modifyCommand(
  kind: Modify, id: string, label: { en: string; ru: string }, fieldLabel: { en: string; ru: string },
  range: { min: number; max: number }, askCanvasBounds: boolean, shortcut: string | null,
  apply: (selection: PixelSelection, width: number, height: number, amount: number, applyAtCanvasBounds: boolean) => PixelSelection | null,
): CommandDefinition {
  return {
    id,
    label: { en: `${label.en}…`, ru: `${label.ru}…` },
    category: CATEGORY_SELECT,
    ...(shortcut ? { shortcut } : {}),
    surfaces: ["menu", "palette", "canvas-context"],
    isEnabled: hasSelection,
    execute: async ({ activeDocumentId }) => {
      if (!activeDocumentId || !kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection) return;
      const answer = await selectModifyModal({ title: label, label: fieldLabel, ...range, step: 1, askCanvasBounds, ...lastModify[kind] });
      if (!answer) return;
      lastModify[kind] = answer;
      await changeRasterSelection(activeDocumentId, `${label.en} (${label.ru})`, (state) => state.selection ? apply(state.selection, state.width, state.height, answer.amount, answer.applyAtCanvasBounds) : null);
    },
  };
}

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
  modifyCommand("feather", "select.feather", { en: "Feather Selection", ru: "Растушевать выделение" }, { en: "Feather radius", ru: "Радиус растушёвки" }, { min: 0, max: 250 }, false, "Shift+F6",
    (selection, width, height, amount) => featherSelection(selection, width, height, amount)),
  modifyCommand("expand", "select.expand", { en: "Expand Selection", ru: "Расширить выделение" }, { en: "Expand by", ru: "Расширить на" }, { min: 1, max: 500 }, false, null,
    (selection, width, height, amount) => expandSelection(selection, width, height, amount)),
  modifyCommand("contract", "select.contract", { en: "Contract Selection", ru: "Сжать выделение" }, { en: "Contract by", ru: "Сжать на" }, { min: 1, max: 500 }, true, null,
    (selection, width, height, amount, atBounds) => contractSelection(selection, width, height, amount, atBounds)),
  modifyCommand("smooth", "select.smooth", { en: "Smooth Selection", ru: "Сгладить выделение" }, { en: "Sample radius", ru: "Радиус выборки" }, { min: 1, max: 500 }, true, null,
    (selection, width, height, amount, atBounds) => smoothSelection(selection, width, height, amount, atBounds)),
  {
    // Photoshop: Select ▸ Transform Selection — the outline only, pixels stay. The session is
    // `TransformSelectionOverlay` on the canvas (Enter applies, Escape cancels) and the
    // Contextual Task Bar's Cancel / Done / Rotate 90°.
    id: "select.transform",
    label: { en: "Transform Selection", ru: "Трансформировать выделение" },
    category: CATEGORY_SELECT,
    surfaces: ["menu", "palette", "canvas-context"],
    isEnabled: hasSelection,
    execute: ({ activeDocumentId }) => {
      const selection = activeDocumentId ? kernel.documents.get<RasterDocumentState>(activeDocumentId)?.state.selection : null;
      if (activeDocumentId && selection) startTransformSelection(activeDocumentId, selection.bounds);
    },
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
