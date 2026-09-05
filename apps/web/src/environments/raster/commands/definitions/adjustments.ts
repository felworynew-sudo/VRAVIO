import { isRasterDocumentState, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "../../../../kernel";
import { CATEGORY_IMAGE } from "../../../../commands/categories";
import type { LocalizedText } from "../../../../i18n";
import type { CommandDefinition } from "../../../../commands/types";

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

const commands: readonly CommandDefinition[] = [
  adjustment("levels", { en: "Levels…", ru: "Уровни…" }, "Mod+L"),
  adjustment("curves", { en: "Curves…", ru: "Кривые…" }, "Mod+M"),
  adjustment("hueSaturation", { en: "Hue/Saturation…", ru: "Цветовой тон/Насыщенность…" }, "Mod+U"),
  adjustment("colorBalance", { en: "Color Balance…", ru: "Цветовой баланс…" }, "Mod+B"),
  adjustment("invert", { en: "Invert", ru: "Инвертировать" }, "Mod+I"),
];

export default commands;
