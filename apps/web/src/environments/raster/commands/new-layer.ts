import { appendLayer, createRasterLayer, parseHexColor, setLayerPixels, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "../../../kernel";
import { newLayerModal } from "../../../modals/runtime";
import type { NewLayerAnswer } from "../../../modals/definitions/new-layer";
import { activeRasterState } from "../../../commands/shared";
import { changeRasterDocument } from "./document-edits";

/**
 * Creating a layer, for every door that creates one.
 *
 * There were two of these: the `layer.new` command pushed the layer onto
 * `state.layers` directly, while the Layers panel's own `+` button used
 * `appendLayer` with the active layer's parent — so a layer made from the
 * keyboard landed at the document root while the same layer made from the
 * button landed inside the open group. Neither was wrong on its own, which is
 * how two of them survived; this is the one both now call (CLAUDE.md §4).
 */

/** Photoshop's default name for the next layer: "Layer 1", "Layer 2", … */
export function defaultNewLayerName(state: RasterDocumentState): string {
  const number = state.layers.length + 1;
  return `Layer ${number} (Слой ${number})`;
}

/** True when the new layer would have something below it to clip to. */
export function canClipToLayerBelow(state: RasterDocumentState): boolean {
  const active = state.layers.find((layer) => layer.id === state.activeLayerId);
  return Boolean(active && active.kind !== "group");
}

/**
 * Adds a layer above the active one, with whatever the New Layer dialog
 * answered — or with plain defaults when nothing was asked.
 *
 * Resolves to the new layer's id, so a caller that keeps its own selection
 * state (the Layers panel) can follow it.
 */
export async function addRasterLayer(documentId: string, answer: NewLayerAnswer | null = null): Promise<string> {
  const state = activeRasterState(documentId);
  if (!state) return "";
  let createdId = "";
  await changeRasterDocument(documentId, "New Layer (Новый слой)", (current) => {
    const selected = current.layers.find((item) => item.id === current.activeLayerId);
    const parentId = selected?.kind === "group" ? selected.id : (selected?.parentId ?? null);
    const layer = createRasterLayer(current.width, current.height, answer?.name || defaultNewLayerName(current));
    if (answer) {
      layer.blendMode = answer.blendMode;
      layer.opacity = answer.opacity;
      layer.colorLabel = answer.colorLabel;
      layer.clipping = answer.clipping;
      if (answer.fill) {
        // Through `setLayerPixels`, the only function that keeps `bounds` and the
        // buffer consistent — a buffer assigned straight into `layer.pixels` leaves
        // the two disagreeing and the layer renders as nothing (CLAUDE.md §2).
        const { r, g, b } = parseHexColor(answer.fill);
        const pixels = new Uint8ClampedArray(current.width * current.height * 4);
        for (let index = 0; index < pixels.length; index += 4) { pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = 255; }
        setLayerPixels(layer, pixels, current.width, current.height, null, { keepOutsideDocument: true });
      }
    }
    appendLayer(current, layer, parentId);
    current.activeLayerId = layer.id;
    createdId = layer.id;
    return true;
  });
  return createdId;
}

/** Opens Photoshop's New Layer dialog and adds the layer it describes. */
export async function addRasterLayerWithDialog(documentId: string): Promise<string> {
  const state = activeRasterState(documentId);
  if (!state) return "";
  const answer = await newLayerModal({ defaultName: defaultNewLayerName(state), canClip: canClipToLayerBelow(state) });
  if (!answer) return "";
  return addRasterLayer(documentId, answer);
}

/** The document a command is acting on, or null — kept here so both doors agree. */
export const newLayerTargetDocument = (documentId?: string | null): string | null =>
  documentId && kernel.documents.get<RasterDocumentState>(documentId) ? documentId : null;
