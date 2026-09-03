import { createMarqueeTool } from "../marquee-selection";

/** Freehand selection, traced dynamically as the pointer moves. Shares its
 * implementation with marquee and ellipseMarquee — see marquee-selection.tsx
 * for why. */
export default createMarqueeTool("raster.lasso", "lasso");
