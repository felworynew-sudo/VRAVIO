import { confineToSelection } from "@vravio/env-raster";
import type { RasterRule } from "../types";

/**
 * An edit stays inside the selection.
 *
 * Moved verbatim out of `commitPixels`, which is where this has been enforced
 * since `b7c1f84` — the point being that it is enforced once, for every tool,
 * including the ones written later that forget. Every tool also masks as it
 * paints, so for an honest tool this changes nothing; it is here for the one
 * that does not.
 *
 * Only the layer's own pixels: painting a mask is how a selection is turned
 * into one in the first place, so confining that to the selection would make
 * the operation refuse to do its job.
 */
const selectionConfinesEdits: RasterRule = {
  id: "selection-confines-edits",
  order: 30,
  applies: (edit, context) => edit.target === "pixels" && context.document.selection !== null,
  transform: (edit, context) => {
    const selection = context.document.selection;
    if (!selection) return edit;
    return { ...edit, after: confineToSelection(edit.before, edit.after, selection.mask) };
  },
};

export default selectionConfinesEdits;
