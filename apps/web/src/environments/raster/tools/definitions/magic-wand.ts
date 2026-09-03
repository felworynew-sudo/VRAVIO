import { combineSelections, createContiguousColorSelection, restrictSelectionToAlpha, type SelectionCombineMode } from "@vravio/env-raster";
import type { RasterToolDefinition } from "../types";

/**
 * The magic wand: a contiguous colour selection from the pixel clicked.
 *
 * The second single-click tool ported after raster.fill (stage 5 of
 * docs/migration-plan.md), and the first to write a selection instead of
 * pixels — what `ctx.commitSelection` exists for. Structurally the same
 * shape as fill: one isolated `onPointerDown` branch, nothing shared with
 * another tool's pipeline.
 */

const magicWand: RasterToolDefinition<null> = {
  id: "raster.magicWand",
  createState: () => null,

  onPointerDown(context, pointer) {
    const source = context.options.allLayers === false ? context.layerPixels() : context.compositePixels();
    const { document } = context;
    const tolerance = Number(context.options.tolerance ?? 32);

    const raw = createContiguousColorSelection(source, document.width, document.height, pointer.point.x, pointer.point.y, tolerance);
    // A selection is a region of the canvas, not of the layer — but the
    // wand's own click is colour-driven, and colour only exists where
    // something opaque was clicked on. Restricting the result to opaque
    // pixels here is what keeps a click on empty canvas from selecting the
    // empty canvas.
    const incoming = restrictSelectionToAlpha(raw, source, document.width, document.height);

    const mode = (pointer.shiftKey && pointer.altKey ? "intersect" : pointer.shiftKey ? "add" : pointer.altKey ? "subtract" : "replace") as SelectionCombineMode;
    const next = incoming ? combineSelections(context.selection, incoming, document.width, document.height, mode) : mode === "replace" ? null : context.selection;

    void context.commitSelection(context.selection, next, "Magic Wand Selection (Выделение волшебной палочкой)");
  },
};

export default magicWand;
