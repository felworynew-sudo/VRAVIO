import { isRasterDocumentState, rasterColorSpaceById, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "../../../../kernel";
import { setSoftProof, softProof, type ProofDestination } from "../../../../soft-proof";
import { CATEGORY_VIEW } from "../../../../commands/categories";
import { isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";

/**
 * View ▸ Proof Colors, Proof Setup and Gamut Warning (docs/master-plan.md §59.3).
 *
 * Proofing is a property of the *view*, not of the document, so nothing here touches pixels or
 * history — it changes what the screen shows and asks for a repaint. Photoshop's own shortcuts:
 * Ctrl+Y proofs, Ctrl+Shift+Y warns.
 */

/** The canvas draws from the document on this event, which is the repaint the proof needs; the
 *  proof itself is applied further down, at the one door pixels take to the screen. */
const repaint = () => {
  for (const document of kernel.documents.list()) {
    if (!isRasterDocumentState(kernel.documents.get<RasterDocumentState>(document.id)?.state)) continue;
    window.dispatchEvent(new CustomEvent("vravio-raster-preview", { detail: { documentId: document.id, pixels: null } }));
  }
};

const DEFAULT_DESTINATION: ProofDestination = "cmyk";

const proofColors: CommandDefinition = {
  id: "view.proofColors",
  label: { en: "Proof Colors", ru: "Цветопроба" },
  category: CATEGORY_VIEW,
  shortcut: "Mod+Y",
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: () => {
    const current = softProof();
    setSoftProof(current ? null : { destination: DEFAULT_DESTINATION, gamutWarning: false });
    repaint();
  },
};

const gamutWarning: CommandDefinition = {
  id: "view.gamutWarning",
  label: { en: "Gamut Warning", ru: "Предупреждение о цветовом охвате" },
  category: CATEGORY_VIEW,
  shortcut: "Mod+Shift+Y",
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: () => {
    const current = softProof();
    // Turning the warning on with no proof set up would have nothing to warn against, so it starts
    // the proof too — the same thing Photoshop does when Gamut Warning is switched on first.
    setSoftProof(current ? { ...current, gamutWarning: !current.gamutWarning } : { destination: DEFAULT_DESTINATION, gamutWarning: true });
    repaint();
  },
};

/** One command per destination, the same shape as Smart Crop's ratio argument: the menu passes
 *  which device to proof for, rather than one hand-wired command per entry. */
const proofSetup: CommandDefinition = {
  id: "view.proofSetup",
  label: { en: "Proof Setup", ru: "Параметры цветопробы" },
  category: CATEGORY_VIEW,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: (_context, args) => {
    const destination = (args?.destination as ProofDestination | undefined) ?? DEFAULT_DESTINATION;
    if (destination !== "cmyk" && !rasterColorSpaceById(destination)) return;
    const current = softProof();
    setSoftProof({ destination, gamutWarning: current?.gamutWarning ?? false });
    repaint();
  },
};

export default [proofColors, gamutWarning, proofSetup];
