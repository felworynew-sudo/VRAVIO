import { buildIndexedPalette, compositeRasterDocument, paletteFromHex, isRasterDocumentState, labEncodedToRgb, layerDocumentPixels, limitToCmykGamut, paletteToHex, rgbToLabEncoded, setLayerPixels, snapToPalette, type RasterColorModel, type RasterDocumentState } from "@vravio/env-raster";
import { withBusy } from "../../../../busy";
import { kernel } from "../../../../kernel";
import { localized } from "../../../../i18n";
import { useShellStore } from "../../../../store";
import { colorTableModal, indexedColorModal } from "../../../../modals/runtime";
import { CATEGORY_IMAGE } from "../../../../commands/categories";
import { isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";

/**
 * Image ▸ Mode's remaining models: Lab, CMYK and Indexed Color (docs/master-plan.md §59.3).
 *
 * Each one converts every pixel layer and tags the document, and each is then *held* to its own
 * rule by the rules engine, so the mode survives the next brush stroke instead of being a label on
 * a one-off conversion. What each mode really is, stated where it is implemented rather than
 * implied by the menu:
 *
 *   - **Lab**: layers are stored Lab-encoded (L·255/100, a+128, b+128 — Photoshop's own 8-bit Lab
 *     encoding). The compositor converts to RGB on the way to the screen, so a curve applied in
 *     this mode really does act on lightness and the two colour axes.
 *   - **CMYK**: pixels are limited to what a four-ink separation can reproduce, and exports carry
 *     the separation. The four plates are *derived*, not stored, so there is no per-plate curve —
 *     that needs four-channel storage the compositor does not have.
 *   - **Indexed**: the document gets a colour table, pixels are snapped onto it (median cut, with
 *     optional Floyd–Steinberg dithering), and the rule keeps them there.
 *
 * Undo restores the pixels it replaced, because none of these conversions is reversible by running
 * it backwards — they all throw colour away on purpose.
 */

const documentFor = (activeDocumentId: string | null | undefined) => {
  const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
  return document && isRasterDocumentState(document.state) ? document : null;
};

/** Converts every pixel layer through `convert`, with undo, and records the new model. */
async function changeModel(
  activeDocumentId: string,
  model: RasterColorModel,
  busyLabel: string,
  convert: (pixels: Uint8ClampedArray, state: RasterDocumentState) => Uint8ClampedArray,
  nextPalette?: readonly string[],
): Promise<void> {
  const document = documentFor(activeDocumentId);
  if (!document) return;
  const state = document.state, before = state.colorModel, beforePalette = state.palette;
  const language = useShellStore.getState().language;
  const layers = state.layers.filter((layer) => layer.kind === "pixel");
  const converted = await withBusy(localized(busyLabel, language), () => layers.map((layer) => {
    const source = layerDocumentPixels(layer, state.width, state.height).slice();
    return { id: layer.id, before: source, after: convert(source.slice(), state) };
  }));

  const apply = (nextModel: RasterColorModel, pick: (entry: { before: Uint8ClampedArray; after: Uint8ClampedArray }) => Uint8ClampedArray, palette: readonly string[] | undefined) => {
    kernel.documents.update<RasterDocumentState>(activeDocumentId, (current) => {
      current.colorModel = nextModel;
      if (palette) current.palette = palette; else delete current.palette;
      for (const entry of converted) {
        const layer = current.layers.find((item) => item.id === entry.id);
        if (layer) setLayerPixels(layer, pick(entry), current.width, current.height, null, { keepOutsideDocument: true });
      }
    });
  };

  const history = kernel.historyByDocument.get(activeDocumentId);
  const memoryEstimate = converted.reduce((sum, entry) => sum + entry.before.byteLength + entry.after.byteLength, 0);
  if (history) await history.execute({ label: `Mode: ${model}`, memoryEstimate, redo: () => apply(model, (entry) => entry.after, nextPalette), undo: () => apply(before, (entry) => entry.before, beforePalette) });
  else apply(model, (entry) => entry.after, nextPalette);
}

const toLab: CommandDefinition = {
  id: "image.mode.lab",
  label: { en: "Lab Color", ru: "Lab" },
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = documentFor(activeDocumentId);
    if (!document || !activeDocumentId || document.state.colorModel === "lab") return;
    // From whatever the document is now: a Lab document's own pixels are already Lab-encoded, and
    // any other model's are plain RGB, which is what the encoder takes.
    await changeModel(activeDocumentId, "lab", "Converting to Lab (Преобразование в Lab)", (pixels, state) => rgbToLabEncoded(pixels, state.colorSpace));
  },
};

const toCmyk: CommandDefinition = {
  id: "image.mode.cmyk",
  label: { en: "CMYK Color", ru: "CMYK" },
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = documentFor(activeDocumentId);
    if (!document || !activeDocumentId || document.state.colorModel === "cmyk") return;
    await changeModel(activeDocumentId, "cmyk", "Converting to CMYK (Преобразование в CMYK)", (pixels, state) => {
      const rgb = state.colorModel === "lab" ? labEncodedToRgb(pixels, state.colorSpace) : pixels;
      limitToCmykGamut(rgb);
      return rgb;
    });
  },
};

const toIndexed: CommandDefinition = {
  id: "image.mode.indexed",
  label: { en: "Indexed Color…", ru: "Индексированные цвета…" },
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = documentFor(activeDocumentId);
    if (!document || !activeDocumentId) return;
    const state = document.state;
    const options = await indexedColorModal({ colors: state.palette?.length ?? 256 });
    if (!options) return;
    // The palette is built from the flattened picture, not from one layer: an indexed document has
    // one colour table for the whole image, which is the point of the mode.
    const language = useShellStore.getState().language;
    const flat = await withBusy(localized("Building colour table (Построение таблицы цветов)", language), () =>
      // The whole picture, not one layer: an indexed document has one table for the image.
      buildIndexedPalette(compositeRasterDocument(state), options.colors));
    await changeModel(activeDocumentId, "indexed", "Converting to Indexed Color (Преобразование в индексированные цвета)", (pixels, current) => {
      const rgb = current.colorModel === "lab" ? labEncodedToRgb(pixels, current.colorSpace) : pixels;
      snapToPalette(rgb, current.width, current.height, flat, options.dither);
      return rgb;
    }, paletteToHex(flat));
  },
};

const colorTable: CommandDefinition = {
  id: "image.mode.colorTable",
  label: { en: "Color Table…", ru: "Таблица цветов…" },
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  // Only an indexed document has one, which is exactly when Photoshop enables this entry too.
  isEnabled: (context) => isRasterActive(context) && documentFor(context.activeDocumentId)?.state.colorModel === "indexed",
  execute: async ({ activeDocumentId }) => {
    const document = documentFor(activeDocumentId);
    if (!document || !activeDocumentId || document.state.colorModel !== "indexed" || !document.state.palette) return;
    const edited = await colorTableModal({ colors: document.state.palette });
    if (!edited) return;
    const palette = paletteFromHex(edited);
    // Changing the table changes the picture: every pixel is re-mapped onto the new entries, which
    // is what makes editing a swatch here an edit rather than a note.
    await changeModel(activeDocumentId, "indexed", "Applying colour table (Применение таблицы цветов)", (pixels, current) => {
      snapToPalette(pixels, current.width, current.height, palette, false);
      return pixels;
    }, edited);
  },
};

/** Grayscale and RGB live in `color-mode.ts`; this is the rest of Photoshop's list. Kept apart
 *  because those two were the modes that already worked, and mixing them would hide which is
 *  which in the history of this file. */
export default [toLab, toCmyk, toIndexed, colorTable];
