import { convertPixelsColorSpace, isRasterDocumentState, layerDocumentPixels, rasterColorSpaceById, setLayerPixels, type RasterColorSpace, type RasterDocumentState } from "@vravio/env-raster";
import { withBusy } from "../../../../busy";
import { kernel } from "../../../../kernel";
import { localized } from "../../../../i18n";
import { useShellStore } from "../../../../store";
import { colorSpaceModal } from "../../../../modals/runtime";
import { CATEGORY_IMAGE } from "../../../../commands/categories";
import { isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";

/**
 * Photoshop's Assign Profile and Convert to Profile, on this editor's own working spaces
 * (docs/master-plan.md §59).
 *
 * Assign changes the tag only: the same numbers, read as a different space, so the picture
 * changes on screen. Convert rewrites every pixel layer through `convertPixelsColorSpace` so the
 * colours stay where they were, and then re-tags. Masks are single-channel coverage, not colour,
 * and are left alone — the same split Krita and GIMP make.
 */
const documentFor = (activeDocumentId: string | null | undefined) => {
  const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
  return document && isRasterDocumentState(document.state) ? document : null;
};

const assign: CommandDefinition = {
  id: "image.assignColorSpace",
  label: { en: "Assign Profile…", ru: "Назначить профиль…" },
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = documentFor(activeDocumentId);
    if (!document || !activeDocumentId) return;
    const chosen = await colorSpaceModal({ current: document.state.colorSpace, mode: "assign" });
    const next = chosen ? rasterColorSpaceById(chosen)?.id : null;
    if (!next || next === document.state.colorSpace) return;
    const before = document.state.colorSpace;
    const apply = (space: RasterColorSpace) => { kernel.documents.update<RasterDocumentState>(activeDocumentId, (state) => { state.colorSpace = space; }); };
    const history = kernel.historyByDocument.get(activeDocumentId);
    if (history) await history.execute({ label: `Assign Profile: ${next}`, redo: () => apply(next), undo: () => apply(before) });
    else apply(next);
  },
};

const convert: CommandDefinition = {
  id: "image.convertColorSpace",
  label: { en: "Convert to Profile…", ru: "Преобразовать в профиль…" },
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = documentFor(activeDocumentId);
    if (!document || !activeDocumentId) return;
    const chosen = await colorSpaceModal({ current: document.state.colorSpace, mode: "convert" });
    const next = chosen ? rasterColorSpaceById(chosen)?.id : null;
    if (!next || next === document.state.colorSpace) return;
    const from = document.state.colorSpace, state = document.state;

    // Both directions are kept as whole-layer buffers: a colour conversion touches every pixel of
    // every layer, so there is no rectangle to store instead, and an undo has to put back exactly
    // what was there — a conversion is not reversible to the byte (out-of-gamut colours clip).
    const language = useShellStore.getState().language;
    const layers = state.layers.filter((layer) => layer.kind === "pixel");
    const converted = await withBusy(localized("Converting colours (Преобразование цветов)", language), () => layers.map((layer) => {
      const before = layerDocumentPixels(layer, state.width, state.height).slice();
      return { id: layer.id, before, after: convertPixelsColorSpace(before, from, next) };
    }));

    const apply = (space: RasterColorSpace, pick: (entry: { before: Uint8ClampedArray; after: Uint8ClampedArray }) => Uint8ClampedArray) => {
      kernel.documents.update<RasterDocumentState>(activeDocumentId, (current) => {
        current.colorSpace = space;
        for (const entry of converted) {
          const layer = current.layers.find((item) => item.id === entry.id);
          if (layer) setLayerPixels(layer, pick(entry), current.width, current.height, null, { keepOutsideDocument: true });
        }
      });
    };
    const history = kernel.historyByDocument.get(activeDocumentId);
    const memoryEstimate = converted.reduce((sum, entry) => sum + entry.before.byteLength + entry.after.byteLength, 0);
    if (history) await history.execute({ label: `Convert to Profile: ${next}`, memoryEstimate, redo: () => apply(next, (entry) => entry.after), undo: () => apply(from, (entry) => entry.before) });
    else apply(next, (entry) => entry.after);
  },
};

export default [assign, convert];
