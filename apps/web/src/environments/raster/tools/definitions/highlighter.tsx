import { createPaintStrokeTool } from "../paint-stroke";

/** Logically identical to brush — the lower default opacity that makes it a
 * highlighter is a tools.ts descriptor fact, not tool logic. Shares its
 * implementation with brush, pencil and eraser — see paint-stroke.ts for
 * why. */
export default createPaintStrokeTool({ id: "raster.highlighter", erase: false, pinnedHardness: false, label: "Highlighter (Выделитель)" });
