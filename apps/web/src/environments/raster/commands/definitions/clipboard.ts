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

/**
 * Copies a decoded `sourceWidth × sourceHeight` RGBA image onto a fresh
 * `documentWidth × documentHeight` buffer at `(originX, originY)`, clipping
 * whatever falls outside the document rather than wrapping or throwing.
 *
 * Exported (unlike the rest of this file's helpers) so the placement
 * arithmetic — the part that actually differs between Paste and Paste in
 * Place — has a test that doesn't need a real clipboard round-trip, which
 * a browser will only grant to a genuine user gesture, not a script. See
 * this file's own paste-in-place.test.ts.
 */
export function blitAtOrigin(source: Uint8ClampedArray | Uint8Array, sourceWidth: number, sourceHeight: number, documentWidth: number, documentHeight: number, originX: number, originY: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(documentWidth * documentHeight * 4);
  for (let y = 0; y < sourceHeight; y += 1) {
    const targetY = originY + y;
    if (targetY < 0 || targetY >= documentHeight) continue;
    for (let x = 0; x < sourceWidth; x += 1) {
      const targetX = originX + x;
      if (targetX < 0 || targetX >= documentWidth) continue;
      const from = (y * sourceWidth + x) * 4, to = (targetY * documentWidth + targetX) * 4;
      output[to] = source[from]!;
      output[to + 1] = source[from + 1]!;
      output[to + 2] = source[from + 2]!;
      output[to + 3] = source[from + 3]!;
    }
  }
  return output;
}

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

/**
 * master-plan.md §1.9 item 7: "paste in place" needs to know where a copy
 * came from, but the system clipboard holds a plain PNG blob with no
 * document-coordinate metadata once it leaves this function. Remembered
 * here instead — the same module-level "last ... until the next one"
 * pattern `select.ts`'s `lastSelectionByDocument` already uses for
 * Reselect, not a per-document store entry, because a real clipboard
 * isn't scoped to a document either.
 */
let lastCopyOrigin: { x: number; y: number } | null = null;

async function copyToClipboard(state: RasterDocumentState): Promise<boolean> {
  const region = copyRegion(state);
  const canvas = regionCanvas(state);
  if (!canvas) return false;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return false;
  await kernel.platform.clipboard.writeImage(blob);
  lastCopyOrigin = { x: region.x, y: region.y };
  return true;
}

const hasRaster = (activeDocumentId: string | null | undefined): RasterDocumentState | null => activeRasterState(activeDocumentId);

/**
 * The shared half of Paste and Paste in Place: read the clipboard, decode
 * it, and land it in a new layer at `(originX, originY)` — top-left for a
 * plain paste, the remembered copy position for paste-in-place. A new
 * layer, never a write into the current one, for the same reason `edit.paste`
 * already picked that shape (see this file's own top comment).
 */
async function pasteImageAt(activeDocumentId: string, document: { state: RasterDocumentState }, originX: number, originY: number, label: string): Promise<void> {
  const clipboard = await kernel.platform.clipboard.readImage();
  if (clipboard.kind === "denied") {
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

  const canvasSized = blitAtOrigin(pasted, decoded.width, decoded.height, state.width, state.height, originX, originY);

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
  await history.execute({ label, redo: () => assign(after), undo: () => assign(before) });
}

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
    // Placed at the top-left rather than centred: centring a paste that is
    // larger than the canvas would put most of it off two edges instead of
    // one, and "it appeared at the corner" is at least predictable.
    execute: async ({ activeDocumentId }) => {
      const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
      if (!activeDocumentId || !document || !isRasterDocumentState(document.state)) return;
      await pasteImageAt(activeDocumentId, document, 0, 0, "Paste (Вставить)");
    },
  },
  {
    id: "edit.pasteInPlace",
    label: { en: "Paste in Place", ru: "Вставить на то же место" },
    category: CATEGORY_EDIT,
    shortcut: "Mod+Shift+V",
    surfaces: ["menu", "palette"],
    isEnabled: (context) => kernel.platform.clipboard.canReadImages && isRasterActive(context),
    // master-plan.md §1.9 item 7: lands the pasted image at the document
    // coordinates it was last copied/cut FROM (lastCopyOrigin), not the
    // canvas top-left plain Paste always uses. That memory only exists for
    // a copy this session made from this app's own canvas — nothing else
    // could have set it — so a clipboard image from anywhere else (another
    // app, a fresh session) falls back to the exact same top-left placement
    // as plain Paste, which is the only sane placement when there is no
    // "same place" to speak of.
    execute: async ({ activeDocumentId }) => {
      const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
      if (!activeDocumentId || !document || !isRasterDocumentState(document.state)) return;
      const origin = lastCopyOrigin ?? { x: 0, y: 0 };
      await pasteImageAt(activeDocumentId, document, origin.x, origin.y, "Paste in Place (Вставить на то же место)");
    },
  },
];

export default commands;
