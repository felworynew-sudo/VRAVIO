import { compositeRasterDocument, cropRasterDocument, findSmartCrop, isRasterDocumentState, type RasterDocumentState } from "@vravio/env-raster";
import { withBusyPainted } from "../../../../busy";
import { diagnostic } from "../../../../diagnostics";
import { localized } from "../../../../i18n";
import { kernel } from "../../../../kernel";
import { useShellStore } from "../../../../store";
import { CATEGORY_IMAGE } from "../../../../commands/categories";
import { isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";

/**
 * Crops to the most interesting region of the picture at a chosen ratio.
 *
 * The first command in the application to take an argument, and the reason
 * `args` stopped being a field nobody read. It was three menu entries — 1:1,
 * 16:9, 4:5 — each a separate hard-coded call in `App.tsx`, which is the same
 * duplication one command with a `ratio` argument removes. A fourth ratio is
 * now a line in `RATIOS`, not a fourth menu entry wired up by hand.
 *
 * It is also the shape a recorded script needs: "crop to 16:9" is a step worth
 * replaying, and one that means nothing without the ratio travelling with it.
 */
const RATIOS: Readonly<Record<string, number>> = {
  "1:1": 1,
  "16:9": 16 / 9,
  "4:5": 4 / 5,
  "3:2": 3 / 2,
};

/** A deep copy: history holds both sides, and neither may share a buffer with
 * the live document or an undo would write through to the thing it restores. */
const clone = (snapshot: RasterDocumentState): RasterDocumentState => ({
  ...snapshot,
  layers: snapshot.layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice(), ...(layer.mask ? { mask: { ...layer.mask, pixels: layer.mask.pixels.slice() } } : {}) })),
  selection: snapshot.selection ? { mask: snapshot.selection.mask.slice(), bounds: { ...snapshot.selection.bounds } } : null,
  guides: snapshot.guides.map((guide) => ({ ...guide })),
});

const command: CommandDefinition = {
  id: "image.smartCrop",
  label: { en: "Smart Crop", ru: "Умное кадрирование" },
  category: CATEGORY_IMAGE,
  surfaces: ["menu", "palette"],
  args: {
    ratio: { kind: "enum", label: { en: "Aspect ratio", ru: "Соотношение сторон" }, options: Object.keys(RATIOS), default: "1:1" },
  },
  isEnabled: isRasterActive,
  execute: async ({ activeDocumentId }, args) => {
    const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
    if (!activeDocumentId || !document || !isRasterDocumentState(document.state)) return;
    const state = document.state;
    const label = String(args?.ratio ?? "1:1");
    const aspect = RATIOS[label];
    if (aspect === undefined) return;

    // Compositing the document and scoring every region of it takes seconds on
    // a large file, with nothing on screen to say so.
    const { rect, score } = await withBusyPainted(
      localized("Finding a crop (Подбор кадра)", useShellStore.getState().language),
      () => findSmartCrop(compositeRasterDocument(state), state.width, state.height, { aspect }),
    );
    if (rect.width < 8 || rect.height < 8) {
      diagnostic("warn", "smartcrop", "Suggested crop was too small to apply", { documentId: activeDocumentId });
      return;
    }
    diagnostic("info", "smartcrop", `${label}: ${rect.width}×${rect.height} at ${rect.x},${rect.y}`, { score: Math.round(score * 1000) / 1000 });

    const history = kernel.historyByDocument.get(activeDocumentId);
    if (!history) return;
    const assign = (snapshot: RasterDocumentState): void => { kernel.documents.update<RasterDocumentState>(activeDocumentId, (current) => { Object.assign(current, clone(snapshot)); }); };
    const before = clone(state), after = cropRasterDocument(before, rect);
    await history.execute({ label: `Smart Crop (Умное кадрирование): ${label}`, redo: () => assign(after), undo: () => assign(before) });
    useShellStore.getState().setViewport(activeDocumentId, { mode: "fit", panX: 0, panY: 0 });
  },
};

export default command;
export { RATIOS as smartCropRatios };
