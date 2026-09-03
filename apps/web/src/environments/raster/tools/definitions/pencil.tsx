import { createPaintStrokeTool } from "../paint-stroke";

/** A hard, 1px-edge stroke regardless of the hardness option — the only way
 * it differs from brush. Shares its implementation with brush, highlighter
 * and eraser — see paint-stroke.ts for why. */
export default createPaintStrokeTool({ id: "raster.pencil", erase: false, pinnedHardness: true, label: "Pencil (Карандаш)" });
