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
 * master-plan.md §1.9 item 3 / §19.2: Ctrl+I is context-sensitive, the same
 * way Photoshop's own is — it targets whichever mask is currently being
 * edited (`editingMaskLayerIdByDocument`, set by clicking a mask thumbnail)
 * rather than always opening the pixel Invert dialog. Confirmed against
 * Patchy's own mask model (`tests/ui/layer_mask_tests.cpp`,
 * `ui_layer_mask_target_paints_inverts_disables_and_applies`): a dedicated
 * `layerInvertMaskAction`, separate from the pixel invert, physically
 * rewrites the mask's pixels (`value = 255 - value`) rather than toggling a
 * flag. VRAVIO's first version of this used a lazy `RasterLayerMask.inverted`
 * boolean the compositor applied only at render time — cheaper, but a real
 * bug: painting on the mask (`raster-pixel-buffers.ts`'s `maskToRgba`/
 * `rgbaToMask`) reads and writes raw `mask.pixels` with no idea an inversion
 * exists, so a white brush stroke on an inverted mask *hid* instead of
 * revealing. Removed the flag entirely (`RasterLayerMask` no longer has
 * `inverted` — see its own comment) rather than leave a second consumer to
 * remember it; this rewrites the buffer once per invert click, not per
 * frame, so every mask consumer (brush, thumbnail, mask→selection, export)
 * reads the one buffer as the single truth. Not a dialog: unlike the pixel
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
  // `layer-context` added alongside the owner's own request: a layer's right-click menu should
  // offer Invert directly, not only through Image ▸ Adjustments — the same reasoning already
  // gave `layer.mergeDown`/`layer.mergeVisible`/`layer.ungroup` this surface.
  surfaces: ["menu", "palette", "layer-context"],
  isEnabled: (context) => Boolean(invertMaskTarget(context.activeDocumentId)) || adjustmentEnabled(context),
  execute: ({ activeDocumentId }) => {
    const maskLayerId = invertMaskTarget(activeDocumentId);
    if (maskLayerId && activeDocumentId) {
      void changeRasterDocument(activeDocumentId, "Invert Layer Mask (Инвертировать маску слоя)", (current) => {
        const layer = current.layers.find((item) => item.id === maskLayerId);
        if (!layer || layer.kind === "group" || !layer.mask) return false;
        const pixels = layer.mask.pixels;
        for (let index = 0; index < pixels.length; index += 1) pixels[index] = 255 - pixels[index]!;
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
