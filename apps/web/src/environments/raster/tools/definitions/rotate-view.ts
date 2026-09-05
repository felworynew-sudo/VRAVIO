import type { RasterToolDefinition } from "../types";

/** Degrees of view rotation per screen pixel dragged sideways. */
const DEGREES_PER_PIXEL = 0.3;
/** Shift snaps to this, the way every rotation in the application does. */
const SNAP_DEGREES = 15;

/**
 * Turns the canvas under the pointer, without touching the document.
 *
 * Horizontal travel only: rotation is one number, and reading it off the
 * angle to the pointer instead would make the canvas spin when the pointer
 * crosses the centre. Photoshop drags this the same way.
 */
export default {
  id: "raster.rotateView",
  createState: () => null,
  navigation: {
    begin: () => "drag",
    move: (context, gesture) => {
      const raw = gesture.initial.rotation + gesture.dx * DEGREES_PER_PIXEL;
      context.setViewport({ rotation: gesture.shiftKey ? Math.round(raw / SNAP_DEGREES) * SNAP_DEGREES : raw, mode: "custom" });
    },
  },
} satisfies RasterToolDefinition<null> as RasterToolDefinition<null>;
