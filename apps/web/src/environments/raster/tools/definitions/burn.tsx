import { createTonalStrokeTool } from "../tonal-stroke";

/** Darkens pixels, weighted toward the chosen tonal range. Shares its
 * implementation with blur, smudge and dodge — see tonal-stroke.ts for why. */
export default createTonalStrokeTool({ id: "raster.burn", kind: "burn", label: "Burn (Затемнитель)" });
