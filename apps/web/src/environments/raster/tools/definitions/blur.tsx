import { createTonalStrokeTool } from "../tonal-stroke";

/** Softens pixels by blending each dab with a local average of the
 * untouched source. Shares its implementation with smudge, dodge and burn
 * — see tonal-stroke.ts for why. */
export default createTonalStrokeTool({ id: "raster.blur", kind: "blur", label: "Blur (Размытие)" });
