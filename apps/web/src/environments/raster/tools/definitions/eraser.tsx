import { createPaintStrokeTool } from "../paint-stroke";

/** Erases the layer's own pixels; on a mask it paints white instead, since a
 * mask pixel is a threshold rather than an alpha channel to punch a hole
 * in — see paint-stroke.ts's `resolveColor`. Shares its implementation with
 * brush, pencil and highlighter — see paint-stroke.ts for why. */
export default createPaintStrokeTool({ id: "raster.eraser", erase: true, pinnedHardness: false, label: "Eraser (Ластик)" });
