import { createMarqueeTool } from "../marquee-selection";

/** Elliptical selection. Shares its implementation with marquee and lasso —
 * see marquee-selection.tsx for why. */
export default createMarqueeTool("raster.ellipseMarquee", "ellipse");
