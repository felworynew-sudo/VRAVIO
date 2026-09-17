import { describe, expect, it } from "vitest";
import { HistoryManager } from "@vravio/kernel";
import { createRasterDocument, createRasterLayerMask, layerDocumentPixels, setLayerPixels, TileStore, type RasterDocumentState } from "@vravio/env-raster";
import { ensureCommandsRegistered } from "../../../commands";
import { kernel } from "../../../kernel";
import { useShellStore } from "../../../store";

/**
 * The mask commands moved out of the Layers panel (master-plan §11): what each
 * does to the document, through the registry — the same door the panel, the
 * Layer menu and the Contextual Task Bar use. Lives one level above
 * `./definitions/` for the reason `clipboard-blit.test.ts` gives.
 */
function open(): { id: string; get(): RasterDocumentState } {
  ensureCommandsRegistered();
  const state = createRasterDocument(4, 2);
  const layer = state.layers.find((item) => item.id === state.activeLayerId)!;
  setLayerPixels(layer, new Uint8ClampedArray(4 * 2 * 4).fill(200), 4, 2);
  const mask = createRasterLayerMask(4, 2);
  // Left half hidden, right half shown.
  mask.tiles = TileStore.fromPixels(Uint8ClampedArray.from([0, 0, 255, 255, 0, 0, 255, 255]), 4, 2, 1);
  layer.mask = mask;
  const document = kernel.documents.create("raster", "mask-commands", state);
  kernel.historyByDocument.set(document.id, new HistoryManager());
  return { id: document.id, get: () => kernel.documents.get<RasterDocumentState>(document.id)!.state };
}

const active = (state: RasterDocumentState) => state.layers.find((layer) => layer.id === state.activeLayerId)!;

describe("layer mask commands", () => {
  it("disables and re-enables the mask as two undoable steps", async () => {
    const document = open();
    expect(await kernel.commands.execute("layer.toggleMaskEnabled", { activeDocumentId: document.id })).toBe(true);
    expect(active(document.get()).mask?.enabled).toBe(false);
    await kernel.commands.execute("layer.toggleMaskEnabled", { activeDocumentId: document.id });
    expect(active(document.get()).mask?.enabled).toBe(true);
    await kernel.historyByDocument.get(document.id)!.undo();
    expect(active(document.get()).mask?.enabled).toBe(false);
  });

  it("deletes the mask and stops editing it", async () => {
    const document = open();
    useShellStore.getState().setEditingMask(document.id, document.get().activeLayerId);
    await kernel.commands.execute("layer.deleteMask", { activeDocumentId: document.id });
    expect(active(document.get()).mask).toBeUndefined();
    expect(useShellStore.getState().editingMaskLayerIdByDocument[document.id]).toBeNull();
    expect(await kernel.commands.execute("layer.deleteMask", { activeDocumentId: document.id })).toBe(false);
  });

  it("bakes the mask into alpha when applied", async () => {
    const document = open();
    await kernel.commands.execute("layer.applyMask", { activeDocumentId: document.id });
    const layer = active(document.get());
    expect(layer.mask).toBeUndefined();
    const pixels = layerDocumentPixels(layer, 4, 2);
    expect([pixels[3], pixels[7], pixels[11], pixels[15]]).toEqual([0, 0, 200, 200]);
  });
});
