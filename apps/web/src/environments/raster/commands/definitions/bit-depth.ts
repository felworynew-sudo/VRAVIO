import { documentPixelBytes, isRasterDocumentState, layerAtDepth, type RasterBitDepth, type RasterDocumentState } from "@vravio/env-raster";
import { withBusy } from "../../../../busy";
import { kernel } from "../../../../kernel";
import { localized } from "../../../../i18n";
import { useShellStore } from "../../../../store";
import { CATEGORY_IMAGE } from "../../../../commands/categories";
import { isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";

/**
 * Image ▸ Mode ▸ 8 / 16 / 32 Bits/Channel (docs/master-plan.md §59.2).
 *
 * The conversion is the storage: every pixel layer's tiles are rebuilt at the new depth, and the
 * document records it. Undo puts the original stores back by reference — going down is lossy
 * (rounding and clipping), so re-converting upward would not restore what was thrown away, and
 * keeping the old tiles is the only honest undo. That costs one document's worth of memory per
 * step, which `memoryEstimate` tells history about so it can budget for it like any other edit.
 */
const changeDepth = (depth: RasterBitDepth, label: { en: string; ru: string }): CommandDefinition => ({
  id: `image.depth.${depth}`,
  label,
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }) => {
    const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
    if (!document || !activeDocumentId || !isRasterDocumentState(document.state)) return;
    const state = document.state;
    if (state.bitDepth === depth) return;
    const from = state.bitDepth;
    const language = useShellStore.getState().language;

    const before = state.layers.map((layer) => ({ id: layer.id, tiles: layer.tiles }));
    const after = await withBusy(localized(`Converting to ${depth} bits/channel (Преобразование в ${depth} бит/канал)`, language),
      () => state.layers.map((layer) => ({ id: layer.id, tiles: layerAtDepth(layer, depth).tiles })));

    const apply = (nextDepth: RasterBitDepth, tiles: readonly { id: string; tiles: RasterDocumentState["layers"][number]["tiles"] }[]) => {
      kernel.documents.update<RasterDocumentState>(activeDocumentId, (current) => {
        current.bitDepth = nextDepth;
        for (const entry of tiles) {
          const layer = current.layers.find((item) => item.id === entry.id);
          if (layer) { layer.tiles = entry.tiles; layer.pixelsRevision += 1; }
        }
      });
    };
    const history = kernel.historyByDocument.get(activeDocumentId);
    const memoryEstimate = documentPixelBytes(state.width, state.height, from) + documentPixelBytes(state.width, state.height, depth);
    if (history) await history.execute({ label: `Mode: ${depth} Bits/Channel`, memoryEstimate, redo: () => apply(depth, after), undo: () => apply(from, before) });
    else apply(depth, after);
  },
});

export default [
  changeDepth(8, { en: "8 Bits/Channel", ru: "8 бит/канал" }),
  changeDepth(16, { en: "16 Bits/Channel", ru: "16 бит/канал" }),
  changeDepth(32, { en: "32 Bits/Channel", ru: "32 бита/канал" }),
];
