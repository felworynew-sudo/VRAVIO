import { isRasterDocumentState, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "../../../../kernel";
import { useShellStore } from "../../../../store";
import { CATEGORY_IMAGE } from "../../../../commands/categories";
import type { LocalizedText } from "../../../../i18n";
import type { CommandDefinition } from "../../../../commands/types";
import { changeRasterDocument } from "../document-edits";

/**
 * The five destructive adjustments that open a dialog.
 *
 * Each dispatches to the shell, which owns the dialog and commits one command
 * when it is accepted — see the preview effect in `raster-commit.ts` for why
 * the document stays untouched until then.
 */
const openAdjustment = (kind: string): void => { window.dispatchEvent(new CustomEvent("vravio-adjustment-open", { detail: { kind } })); };

/** An adjustment rewrites pixels, so it needs a layer that has some. */
const adjustmentEnabled = ({ activeDocumentId }: { activeDocumentId?: string | null }) => {
  const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
  return Boolean(document && isRasterDocumentState(document.state) && document.state.layers.find((layer) => layer.id === document.state.activeLayerId)?.kind === "pixel");
};

const adjustment = (kind: string, label: LocalizedText, shortcut: string): CommandDefinition => ({
  id: `image.adjustment.${kind}`,
  label,
  category: CATEGORY_IMAGE,
  shortcut,
  surfaces: ["menu", "palette"],
  isEnabled: adjustmentEnabled,
  execute: () => openAdjustment(kind),
});

/**
 * master-plan.md §1.9 item 3: Ctrl+I is context-sensitive, the same way
 * Photoshop's own is — it targets whichever mask is currently being edited
 * (`editingMaskLayerIdByDocument`, set by clicking a mask thumbnail) rather
 * than always opening the pixel Invert dialog. Confirmed against Patchy's
 * own mask model (`tests/ui/layer_mask_tests.cpp`,
 * `ui_layer_mask_target_paints_inverts_disables_and_applies`): a dedicated
 * `layerInvertMaskAction`, separate from the pixel invert, flips the mask.
 * VRAVIO already stores this as a lazy `RasterLayerMask.inverted` flag the
 * compositor reads at render time (`render.ts`, `layer-tree.ts`) — flipping
 * it is a flag toggle, not a pixel rewrite, cheaper than Patchy's own
 * (Qt raster ops are typically eager). Not a dialog: unlike the pixel
 * Invert, there is nothing to configure, so it applies immediately as one
 * undo step, matching `layerInvertMaskAction` being a plain trigger, not a
 * dialog opener, in Patchy's own test.
 */
const invertMaskTarget = (activeDocumentId?: string | null): string | null =>
  activeDocumentId ? useShellStore.getState().editingMaskLayerIdByDocument[activeDocumentId] ?? null : null;

const invertCommand: CommandDefinition = {
  id: "image.adjustment.invert",
  label: { en: "Invert", ru: "Инвертировать" },
  category: CATEGORY_IMAGE,
  shortcut: "Mod+I",
  surfaces: ["menu", "palette"],
  isEnabled: (context) => Boolean(invertMaskTarget(context.activeDocumentId)) || adjustmentEnabled(context),
  execute: ({ activeDocumentId }) => {
    const maskLayerId = invertMaskTarget(activeDocumentId);
    if (maskLayerId && activeDocumentId) {
      void changeRasterDocument(activeDocumentId, "Invert Layer Mask (Инвертировать маску слоя)", (current) => {
        const layer = current.layers.find((item) => item.id === maskLayerId);
        if (!layer || layer.kind === "group" || !layer.mask) return false;
        layer.mask.inverted = !layer.mask.inverted;
        return true;
      });
      return;
    }
    openAdjustment("invert");
  },
};

const commands: readonly CommandDefinition[] = [
  adjustment("levels", { en: "Levels…", ru: "Уровни…" }, "Mod+L"),
  adjustment("curves", { en: "Curves…", ru: "Кривые…" }, "Mod+M"),
  adjustment("hueSaturation", { en: "Hue/Saturation…", ru: "Цветовой тон/Насыщенность…" }, "Mod+U"),
  adjustment("colorBalance", { en: "Color Balance…", ru: "Цветовой баланс…" }, "Mod+B"),
  invertCommand,
];

export default commands;
