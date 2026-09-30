import { isRasterDocumentState, resizeRasterCanvas, resizeRasterDocument, setLayerPixels, type Interpolation, type RasterDocumentState } from "@vravio/env-raster";
import { withBusyPainted } from "../../../../busy";
import { CATEGORY_IMAGE } from "../../../../commands/categories";
import { isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";
import { localized } from "../../../../i18n";
import { kernel } from "../../../../kernel";
import { canvasSizeModal, imageSizeModal } from "../../../../modals/runtime";
import { rebakeScene3DLayer, scene3dOffset } from "../../../../scene3d-commands";
import { useShellStore } from "../../../../store";
import { identityTextTransform, multiplyTextTransform, renderTextLayerPixels } from "../../../../textRender";

/**
 * Image ▸ Image Size and Image ▸ Canvas Size (§65.13). The dialogs ask; these do the edit as one
 * undoable step, the way Smart Crop does.
 */

/** Both sides of the history step own their buffers: `tiles.clone()` is copy-on-write, so this
 * costs the tile table, not the image (see smart-crop.ts). */
const clone = (snapshot: RasterDocumentState): RasterDocumentState => ({
  ...snapshot,
  layers: snapshot.layers.map((layer) => ({ ...layer, tiles: layer.tiles.clone(), ...(layer.mask ? { mask: { ...layer.mask, tiles: layer.mask.tiles.clone() } } : {}), ...(layer.text ? { text: structuredClone(layer.text) } : {}) })),
  selection: snapshot.selection ? { mask: snapshot.selection.mask.slice(), bounds: { ...snapshot.selection.bounds } } : null,
  guides: snapshot.guides.map((guide) => ({ ...guide })),
});

async function commit(documentId: string, label: string, before: RasterDocumentState, after: RasterDocumentState): Promise<void> {
  const history = kernel.historyByDocument.get(documentId);
  if (!history) return;
  const assign = (snapshot: RasterDocumentState): void => { kernel.documents.update<RasterDocumentState>(documentId, (current) => { Object.assign(current, clone(snapshot)); }); };
  await history.execute({ label, redo: () => assign(after), undo: () => assign(before) });
  useShellStore.getState().setViewport(documentId, { mode: "fit", panX: 0, panY: 0 });
}

const imageSize: CommandDefinition = {
  id: "image.imageSize",
  label: { en: "Image Size…", ru: "Размер изображения…" },
  category: CATEGORY_IMAGE,
  shortcut: "Mod+Alt+I",
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
    if (!activeDocumentId || !document || !isRasterDocumentState(document.state)) return;
    const state = document.state;
    const answer = await imageSizeModal({ width: state.width, height: state.height, resolution: state.resolution, resolutionUnit: state.resolutionUnit, bytesPerPixel: 4 * (state.bitDepth / 8) });
    if (!answer) return;
    // Everything below reads this snapshot, never the live document: the work waits for a frame
    // (`withBusyPainted`), and a second resize started meanwhile would otherwise find the document
    // already resized and scale it again — found live, a 3D layer halved twice (§65.13).
    const before = clone(document.state);
    if (!answer.resample) {
      if (answer.resolution === before.resolution) return;
      const after = clone(before);
      after.resolution = answer.resolution;
      await commit(activeDocumentId, "Image Size (Размер изображения)", before, after);
      return;
    }
    const shrinking = answer.width * answer.height < before.width * before.height;
    // Photoshop's Automatic: the sharper method for a reduction, the smoother for an enlargement.
    const interpolation: Interpolation = answer.resample === "auto" ? (shrinking ? "lanczos3" : "mitchell") : answer.resample;
    const sx = answer.width / before.width, sy = answer.height / before.height;
    const offsets = new Map(before.layers.filter((layer) => layer.kind === "3d" && layer.scene3d).map((layer) => [layer.id, scene3dOffset(layer, before)] as const));
    const after = await withBusyPainted(localized("Resizing image (Изменение размера)", useShellStore.getState().language), async () => {
      const next = resizeRasterDocument(before, answer.width, answer.height, interpolation);
      next.resolution = answer.resolution;
      // Text and 3D are not pixels at heart: rebuilt from their own data at the new size, crisp,
      // over the resampled stand-in the engine left.
      for (const layer of next.layers) {
        if (layer.kind === "text" && layer.text) {
          layer.text = { ...layer.text, transform: multiplyTextTransform({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }, layer.text.transform ?? identityTextTransform()) };
          setLayerPixels(layer, renderTextLayerPixels(layer.text, next.width, next.height), next.width, next.height);
        } else if (layer.kind === "3d" && layer.scene3d) {
          const offset = offsets.get(layer.id) ?? { x: 0, y: 0 };
          await rebakeScene3DLayer(layer, { ...layer.scene3d, size: layer.scene3d.size * Math.sqrt(sx * sy) }, next, { x: offset.x * sx, y: offset.y * sy });
        }
      }
      return next;
    });
    await commit(activeDocumentId, "Image Size (Размер изображения)", before, after);
  },
};

const canvasSize: CommandDefinition = {
  id: "image.canvasSize",
  label: { en: "Canvas Size…", ru: "Размер холста…" },
  category: CATEGORY_IMAGE,
  shortcut: "Mod+Alt+C",
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
    if (!activeDocumentId || !document || !isRasterDocumentState(document.state)) return;
    const state = document.state;
    const answer = await canvasSizeModal({ width: state.width, height: state.height, resolution: state.resolution, resolutionUnit: state.resolutionUnit });
    if (!answer || (answer.width === state.width && answer.height === state.height)) return;
    const fill = answer.fill ? [Number.parseInt(answer.fill.slice(1, 3), 16), Number.parseInt(answer.fill.slice(3, 5), 16), Number.parseInt(answer.fill.slice(5, 7), 16), 255] as const : null;
    const before = clone(state);
    const after = resizeRasterCanvas(state, answer.width, answer.height, answer.anchor, fill);
    await commit(activeDocumentId, "Canvas Size (Размер холста)", before, after);
  },
};

export default [imageSize, canvasSize];
