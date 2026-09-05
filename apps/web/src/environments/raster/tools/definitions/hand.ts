import type { RasterToolDefinition } from "../types";

/**
 * Drags the view around.
 *
 * The whole tool: pan by however far the pointer has travelled, from where the
 * viewport stood when the drag began. Screen pixels, one to one, at any zoom —
 * the picture follows the hand exactly, which is the only thing this tool has
 * ever had to get right.
 *
 * Also what the space bar and the middle mouse button run, without becoming
 * the active tool: see `NavigationHooks` in ../types.ts.
 */
export default {
  id: "raster.hand",
  createState: () => null,
  navigation: {
    begin: () => "drag",
    move: (context, gesture) => context.setViewport({ panX: gesture.initial.panX + gesture.dx, panY: gesture.initial.panY + gesture.dy, mode: "custom" }),
  },
} satisfies RasterToolDefinition<null> as RasterToolDefinition<null>;
