import { createTonalStrokeTool } from "../tonal-stroke";

/** Drags colour along the stroke like a finger through wet paint. Shares
 * its implementation with blur, dodge and burn — see tonal-stroke.ts for
 * why. */
export default createTonalStrokeTool({ id: "raster.smudge", kind: "smudge", label: "Smudge (Палец)" });
