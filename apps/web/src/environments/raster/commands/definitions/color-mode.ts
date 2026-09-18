import { applyRasterFilter, isRasterDocumentState, layerDocumentPixels, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import { withBusy } from "../../../../busy";
import { kernel } from "../../../../kernel";
import { localized } from "../../../../i18n";
import { useShellStore } from "../../../../store";
import { CATEGORY_IMAGE } from "../../../../commands/categories";
import { isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";

/**
 * Image ▸ Mode ▸ RGB Color / Grayscale (docs/master-plan.md §59).
 *
 * The two models this editor can honestly carry. Grayscale converts every pixel layer to Rec. 709
 * luma and tags the document, and the `grayscale-document` rule then keeps it grey no matter what
 * paints into it afterwards — the mode is a property of the document, not a one-off filter, which
 * is the whole difference between this and Filter ▸ Grayscale.
 *
 * Going back to RGB does not restore the colours (Photoshop's does not either: the conversion threw
 * them away), it only lets colour in again. Undo does restore them, since the buffers are kept.
 *
 * Bitmap, Duotone, Indexed Color, CMYK, Lab and Multichannel are not here: each needs its own
 * storage and compositing, and a menu entry that only renamed the document would be exactly the
 * control that does nothing CLAUDE.md §3 forbids. They appear in the menu disabled, with the
 * reason, as Photoshop itself greys out the modes a document cannot enter.
 */
const documentFor = (activeDocumentId: string | null | undefined) => {
  const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
  return document && isRasterDocumentState(document.state) ? document : null;
};

const toGrayscale: CommandDefinition = {
  id: "image.mode.grayscale",
  label: { en: "Grayscale", ru: "Градации серого" },
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = documentFor(activeDocumentId);
    if (!document || !activeDocumentId || document.state.colorModel === "grayscale") return;
    const state = document.state;
    const language = useShellStore.getState().language;
    const layers = state.layers.filter((layer) => layer.kind === "pixel");
    const converted = await withBusy(localized("Converting to Grayscale (Преобразование в градации серого)", language), () => layers.map((layer) => {
      const before = layerDocumentPixels(layer, state.width, state.height).slice();
      return { id: layer.id, before, after: applyRasterFilter(before, state.width, state.height, "grayscale") };
    }));

    const apply = (model: "rgb" | "grayscale", pick: (entry: { before: Uint8ClampedArray; after: Uint8ClampedArray }) => Uint8ClampedArray) => {
      kernel.documents.update<RasterDocumentState>(activeDocumentId, (current) => {
        current.colorModel = model;
        for (const entry of converted) {
          const layer = current.layers.find((item) => item.id === entry.id);
          if (layer) setLayerPixels(layer, pick(entry), current.width, current.height, null, { keepOutsideDocument: true });
        }
      });
    };
    const history = kernel.historyByDocument.get(activeDocumentId);
    const memoryEstimate = converted.reduce((sum, entry) => sum + entry.before.byteLength + entry.after.byteLength, 0);
    if (history) await history.execute({ label: "Mode: Grayscale", memoryEstimate, redo: () => apply("grayscale", (entry) => entry.after), undo: () => apply("rgb", (entry) => entry.before) });
    else apply("grayscale", (entry) => entry.after);
  },
};

const toRgb: CommandDefinition = {
  id: "image.mode.rgb",
  label: { en: "RGB Color", ru: "RGB" },
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = documentFor(activeDocumentId);
    if (!document || !activeDocumentId || document.state.colorModel === "rgb") return;
    const apply = (model: "rgb" | "grayscale") => { kernel.documents.update<RasterDocumentState>(activeDocumentId, (state) => { state.colorModel = model; }); };
    const history = kernel.historyByDocument.get(activeDocumentId);
    if (history) await history.execute({ label: "Mode: RGB Color", redo: () => apply("rgb"), undo: () => apply("grayscale") });
    else apply("rgb");
  },
};

export default [toRgb, toGrayscale];
