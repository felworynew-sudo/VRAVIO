import { layerAccepts } from "@vravio/env-raster";
import type { RasterRule } from "../types";

/**
 * A locked layer does not accept pixel edits.
 *
 * `layerAccepts` already knew this; what it lacked was a place that every edit
 * passes through. The check lived in `RasterWorkspace.tsx`'s pointer handler,
 * which means it held for tools that go through the pointer handler — and the
 * plan's section 4.4 is a note about what one checkpoint is worth.
 *
 * "paint" rather than "erase": the two differ only in which message the user
 * is shown, and `layerAccepts` refuses both under `lockPixels`. The message
 * still comes from the pointer handler, which knows which tool asked.
 *
 * Lock Position is not here. It stops a layer moving, and a move commits a
 * whole document state rather than a pixel buffer, so it never reaches this
 * engine — `raster.move` checks it directly, and moving that check needs a
 * document-edit rule this stage does not introduce.
 */
const lockPixels: RasterRule = {
  id: "lock-pixels",
  order: 20,
  applies: (edit) => edit.target === "pixels",
  transform: (edit, context) => (context.layer && !layerAccepts(context.layer, "paint") ? null : edit),
};

export default lockPixels;
