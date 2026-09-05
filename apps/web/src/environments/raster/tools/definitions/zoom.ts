import { clampZoom } from "../../../../raster-coordinates";
import type { NavigationContext, NavigationGesture, RasterToolDefinition } from "../types";

/** One click in, or one click out. Photoshop's own steps. */
const STEP_IN = 1.25, STEP_OUT = 0.8;
/** How fast a scrubby drag zooms, per screen pixel. Exponential, so dragging
 * right by the same distance always multiplies the zoom by the same factor
 * whether you started at 5% or at 800%. */
const DRAG_RATE = 0.01;

/** A click zooms about the point clicked; Alt makes it zoom out. */
const clickZoom = (context: NavigationContext, gesture: NavigationGesture, at: { x: number; y: number }): void => {
  context.zoomAround(clampZoom(gesture.initial.zoom * (gesture.altKey ? STEP_OUT : STEP_IN)), at.x, at.y, gesture.initial);
};

/**
 * Zooms the view in and out.
 *
 * Two behaviours under one tool, which is why this is the only navigation tool
 * with anything to decide. With "scrubby zoom" on — the default, and
 * Photoshop's — pressing and dragging zooms continuously, and a press that
 * never moves still counts as a click zoom on release. With it off, the press
 * itself zooms one step and there is no drag at all.
 *
 * The temporary zoom the space bar offers always takes the second path: the
 * host passes `dragZoom: false` for it, because a modifier held with space is
 * a momentary thing and a scrubby drag is not.
 */
export default {
  id: "raster.zoom",
  createState: () => null,
  navigation: {
    begin: (context, gesture) => {
      if (context.options.dragZoom === false) {
        clickZoom(context, gesture, { x: gesture.clientX, y: gesture.clientY });
        return "done";
      }
      return "drag";
    },
    move: (context, gesture) => {
      // Anchored where the drag began, not where the pointer is now: anchoring
      // at the moving pointer would drag the picture along with the zoom.
      context.zoomAround(clampZoom(gesture.initial.zoom * Math.exp(gesture.dx * DRAG_RATE)), gesture.startX, gesture.startY, gesture.initial);
    },
    end: (context, gesture) => {
      // A press that never became a drag was a click, and a click zooms.
      if (!gesture.moved) clickZoom(context, gesture, { x: gesture.clientX, y: gesture.clientY });
    },
  },
} satisfies RasterToolDefinition<null> as RasterToolDefinition<null>;
