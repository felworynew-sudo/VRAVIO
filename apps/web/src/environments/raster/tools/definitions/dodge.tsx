import { createTonalStrokeTool } from "../tonal-stroke";

/** Lightens pixels, weighted toward the chosen tonal range. Shares its
 * implementation with blur, smudge and burn — see tonal-stroke.ts for why. */
export default createTonalStrokeTool({ id: "raster.dodge", kind: "dodge", label: "Dodge (Осветлитель)" });
