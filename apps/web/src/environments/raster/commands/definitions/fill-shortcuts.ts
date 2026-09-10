import { fillSelectedPixels, fillSelectionInMask, isRasterDocumentState, layerAccepts, layerDocumentPixels, parseHexColor, setLayerPixels, type RasterDocumentState, type RasterLayer } from "@vravio/env-raster";
import { kernel } from "../../../../kernel";
import { useShellStore } from "../../../../store";
import { CATEGORY_EDIT } from "../../../../commands/categories";
import { activeRasterState, isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";
import { changeRasterDocument } from "../document-edits";

/**
 * Photoshop's fill hotkeys (Edit > Fill's two fastest doors, no dialog):
 * Alt+Backspace/Option+Delete for Foreground, Ctrl+Backspace/Cmd+Delete for
 * Background — `Mod` already covers the Ctrl/Cmd half of that pair (see
 * `layer.clear`'s own note on `Delete` vs `Backspace` next to this file).
 * Real Photoshop binds both the Backspace and Delete forms of each to the
 * same action; this catalogue carries one shortcut per command, so each
 * gets its single most standard binding rather than two competing entries
 * for one outcome.
 *
 * A mask being edited paints white or black instead of a color — the same
 * target `raster.fill` (the paint bucket tool) already resolves via
 * `paintColor`/`paintTarget` in RasterWorkspace.tsx. That resolution lives
 * in `ToolContext`, unreachable from a menu/keyboard command with no active
 * tool gesture, so this mirrors its one-line ternary rather than routing
 * through the tool.
 */

interface FillTarget {
  readonly layer: RasterLayer;
  readonly maskColor: number | null; // set when filling the mask, not the layer's own pixels
}

function resolveFillTarget(documentId: string, state: RasterDocumentState, foreground: boolean): FillTarget | null {
  const editingMaskLayerId = useShellStore.getState().editingMaskLayerIdByDocument[documentId];
  const editingMaskLayer = editingMaskLayerId ? state.layers.find((item) => item.id === editingMaskLayerId && item.mask) : undefined;
  if (editingMaskLayer) {
    const maskForegroundIsWhite = useShellStore.getState().maskForegroundIsWhiteByDocument[documentId] ?? false;
    const white = foreground ? maskForegroundIsWhite : !maskForegroundIsWhite;
    return { layer: editingMaskLayer, maskColor: white ? 255 : 0 };
  }
  const layer = state.layers.find((item) => item.id === state.activeLayerId);
  if (!layer || layer.kind === "group" || !layerAccepts(layer, "paint")) return null;
  return { layer, maskColor: null };
}

function fill(documentId: string, foreground: boolean, label: string): void {
  const state = activeRasterState(documentId);
  if (!state) return;
  const target = resolveFillTarget(documentId, state, foreground);
  if (!target) return;
  const hex = foreground ? useShellStore.getState().foregroundColor : useShellStore.getState().backgroundColor;
  void changeRasterDocument(documentId, label, (draft) => {
    if (target.maskColor !== null) {
      const layer = draft.layers.find((item) => item.id === target.layer.id);
      if (!layer?.mask) return false;
      layer.mask.pixels = fillSelectionInMask(layer.mask.pixels, draft.width, draft.height, draft.selection, target.maskColor);
      return true;
    }
    const layer = draft.layers.find((item) => item.id === target.layer.id);
    if (!layer || layer.kind === "group" || !layerAccepts(layer, "paint")) return false;
    setLayerPixels(layer, fillSelectedPixels(layerDocumentPixels(layer, draft.width, draft.height), draft.width, draft.height, draft.selection, parseHexColor(hex)), draft.width, draft.height);
    return true;
  });
}

const commands: readonly CommandDefinition[] = [
  {
    id: "edit.fillForeground",
    label: { en: "Fill with Foreground Color", ru: "Залить основным цветом" },
    category: CATEGORY_EDIT,
    shortcut: "Alt+Delete",
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) fill(activeDocumentId, true, "Fill with Foreground Color (Залить основным цветом)"); },
  },
  {
    id: "edit.fillBackground",
    label: { en: "Fill with Background Color", ru: "Залить фоновым цветом" },
    category: CATEGORY_EDIT,
    shortcut: "Mod+Delete",
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) fill(activeDocumentId, false, "Fill with Background Color (Залить фоновым цветом)"); },
  },
];

export default commands;
