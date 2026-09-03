import { createMarqueeTool } from "../marquee-selection";

/** Rectangular selection. Shares its implementation with ellipseMarquee and
 * lasso — see marquee-selection.tsx for why. */
export default createMarqueeTool("raster.marquee", "rectangle");
