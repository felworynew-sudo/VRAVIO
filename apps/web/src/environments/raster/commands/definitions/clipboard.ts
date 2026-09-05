import { activeRasterLayer, appendLayer, createRasterLayer, isRasterDocumentState, layerDocumentPixels, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import { cloneRasterState } from "@vravio/env-raster";
import { kernel } from "../../../../kernel";
import { diagnostic } from "../../../../diagnostics";
import { errorModal } from "../../../../modals/runtime";
import { text } from "../../../../i18n";
import { useShellStore } from "../../../../store";
import { decodeImportedImage } from "../../../../imageImport";
import { CATEGORY_EDIT } from "../../../../commands/categories";
import { activeRasterState, isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";
import { changeRasterDocument } from "../document-edits";

/**
 * Copy, cut and paste, through the platform's clipboard port.
 *
 * The editor could not put anything on the system clipboard at all before
 * this, which is a strange gap in something whose whole job is making
 * pictures. Through the port rather than `navigator.clipboard` directly: the
 * desktop build reaches the clipboard through the operating system, and what
 * differs between them is real (see `ClipboardPort`).
 *
 * What is copied is the *selection*, or the whole layer when nothing is
 * selected — Photoshop's rule. What is pasted is a new layer, never a write
 * into the current one: pasting over work with no way back is not something
 * to do on a keystroke, and a new layer is both undoable and movable.
 */

/** The selection's bounds, or the whole canvas when nothing is selected. */
function copyRegion(state: RasterDocumentState) {
  const selection = state.selection;
  if (!selection) return { x: 0, y: 0, width: state.width, height: state.height, mask: null };
  return { ...selection.bounds, mask: selection.mask };
}

/**
 * Draws what should be copied onto a canvas, ready to become a PNG.
 *
 * Outside the selection is left transparent rather than filled: a selection is
 * a shape, and copying its bounding box with the corners filled in would paste
 * back something the user never selected.
 */
function regionCanvas(state: RasterDocumentState): HTMLCanvasElement | null {
  const region = copyRegion(state);
  if (region.width < 1 || region.height < 1) return null;
  const pixels = layerDocumentPixels(activeRasterLayer(state), state.width, state.height);

  const canvas = document.createElement("canvas");
  canvas.width = region.width;
  canvas.height = region.height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const image = context.createImageData(region.width, region.height);
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const from = ((region.y + y) * state.width + (region.x + x)) * 4;
      const to = (y * region.width + x) * 4;
      const coverage = region.mask ? region.mask[(region.y + y) * state.width + (region.x + x)]! / 255 : 1;
      image.data[to] = pixels[from]!;
      image.data[to + 1] = pixels[from + 1]!;
      image.data[to + 2] = pixels[from + 2]!;
      image.data[to + 3] = Math.round(pixels[from + 3]! * coverage);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

async function copyToClipboard(state: RasterDocumentState): Promise<boolean> {
  const canvas = regionCanvas(state);
  if (!canvas) return false;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return false;
  await kernel.platform.clipboard.writeImage(blob);
  return true;
}

const hasRaster = (activeDocumentId: string | null | undefined): RasterDocumentState | null => activeRasterState(activeDocumentId);

const commands: readonly CommandDefinition[] = [
  {
    id: "edit.copy",
    label: { en: "Copy", ru: "Копировать" },
    category: CATEGORY_EDIT,
    shortcut: "Mod+C",
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: async ({ activeDocumentId }) => {
      const state = hasRaster(activeDocumentId);
      if (!state) return;
      try {
        if (!await copyToClipboard(state)) diagnostic("warn", "clipboard", "Nothing to copy");
      } catch (error) {
        // Writing needs a secure context and a user gesture; a shortcut is one,
        // but an automated or embedded context may not be.
        diagnostic("error", "clipboard", "Could not write to the clipboard", error);
      }
    },
  },
  {
    id: "edit.cut",
    label: { en: "Cut", ru: "Вырезать" },
    category: CATEGORY_EDIT,
    shortcut: "Mod+X",
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => Boolean(hasRaster(activeDocumentId)?.selection),
    execute: async ({ activeDocumentId }) => {
      const state = hasRaster(activeDocumentId);
      if (!state || !activeDocumentId || !state.selection) return;
      try {
        if (!await copyToClipboard(state)) return;
      } catch (error) {
        // The copy failing must not leave the pixels deleted: a cut that
        // removed the work without putting it anywhere is the one outcome
        // there is no way back from except undo.
        diagnostic("error", "clipboard", "Could not write to the clipboard; nothing was cut", error);
        return;
      }
      const selection = state.selection;
      await changeRasterDocument(activeDocumentId, "Cut (Вырезать)", (draft) => {
        const layer = draft.layers.find((item) => item.id === draft.activeLayerId);
        if (!layer) return false;
        const pixels = layerDocumentPixels(layer, draft.width, draft.height).slice();
        for (let index = 0; index < selection.mask.length; index += 1) {
          const coverage = selection.mask[index]! / 255;
          if (coverage > 0) pixels[index * 4 + 3] = Math.round(pixels[index * 4 + 3]! * (1 - coverage));
        }
        setLayerPixels(layer, pixels, draft.width, draft.height);
        return true;
      });
    },
  },
  {
    id: "edit.paste",
    label: { en: "Paste", ru: "Вставить" },
    category: CATEGORY_EDIT,
    shortcut: "Mod+V",
    surfaces: ["menu", "palette"],
    // Disabled where the browser cannot read images back at all, rather than
    // offered and then quietly doing nothing.
    isEnabled: (context) => kernel.platform.clipboard.canReadImages && isRasterActive(context),
    execute: async ({ activeDocumentId }) => {
      const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
      if (!activeDocumentId || !document || !isRasterDocumentState(document.state)) return;

      const clipboard = await kernel.platform.clipboard.readImage();
      if (clipboard.kind === "denied") {
        // Worth saying out loud: the picture *is* on the clipboard, and doing
        // nothing silently would send the user looking for a bug in the copy.
        diagnostic("warn", "clipboard", "The browser refused permission to read the clipboard");
        errorModal({
          title: text(useShellStore.getState().language, "Cannot read the clipboard", "Нет доступа к буферу обмена"),
          message: text(
            useShellStore.getState().language,
            "The browser refused permission to read the clipboard. Allow clipboard access for this page and try again.",
            "Браузер не дал разрешение читать буфер обмена. Разрешите доступ к буферу для этой страницы и попробуйте снова.",
          ),
        });
        return;
      }
      if (clipboard.kind === "empty") { diagnostic("info", "clipboard", "The clipboard holds no image"); return; }
      const blob = clipboard.image;

      const decoded = await decodeImportedImage(new File([blob], "clipboard.png", { type: blob.type || "image/png" }));
      if (!decoded) { diagnostic("warn", "clipboard", "Could not decode the image on the clipboard"); return; }

      const state = document.state;
      const surface = window.document.createElement("canvas");
      surface.width = decoded.width;
      surface.height = decoded.height;
      const context = surface.getContext("2d");
      if (!context) { decoded.release(); return; }
      context.drawImage(decoded.image, 0, 0);
      const pasted = context.getImageData(0, 0, decoded.width, decoded.height).data;
      decoded.release();

      // Placed at the top-left rather than centred: centring a paste that is
      // larger than the canvas would put most of it off two edges instead of
      // one, and "it appeared at the corner" is at least predictable.
      const canvasSized = new Uint8ClampedArray(state.width * state.height * 4);
      for (let y = 0; y < Math.min(decoded.height, state.height); y += 1) {
        for (let x = 0; x < Math.min(decoded.width, state.width); x += 1) {
          const from = (y * decoded.width + x) * 4, to = (y * state.width + x) * 4;
          canvasSized[to] = pasted[from]!;
          canvasSized[to + 1] = pasted[from + 1]!;
          canvasSized[to + 2] = pasted[from + 2]!;
          canvasSized[to + 3] = pasted[from + 3]!;
        }
      }

      const before = cloneRasterState(state);
      const after = cloneRasterState(state);
      const layer = createRasterLayer(after.width, after.height, `Pasted (Вставленное)`);
      setLayerPixels(layer, canvasSized, after.width, after.height);
      appendLayer(after, layer);
      after.activeLayerId = layer.id;

      const history = kernel.historyByDocument.get(activeDocumentId);
      if (!history) return;
      const assign = (snapshot: RasterDocumentState): void => {
        kernel.documents.update<RasterDocumentState>(activeDocumentId, (current) => { Object.assign(current, cloneRasterState(snapshot)); });
      };
      await history.execute({ label: "Paste (Вставить)", redo: () => assign(after), undo: () => assign(before) });
    },
  },
];

export default commands;
