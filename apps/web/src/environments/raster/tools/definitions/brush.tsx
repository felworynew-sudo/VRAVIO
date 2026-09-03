import { createPaintStrokeTool } from "../paint-stroke";

/** Freehand painting. Shares its implementation with pencil, highlighter and
 * eraser — see paint-stroke.ts for why. */
export default createPaintStrokeTool({ id: "raster.brush", erase: false, pinnedHardness: false, label: "Brush Stroke (Мазок кисти)" });
