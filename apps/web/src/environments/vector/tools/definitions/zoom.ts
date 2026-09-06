import { clampZoom } from "../../../../raster-coordinates";
import type { NavigationContext, NavigationGesture, VectorToolDefinition } from "../types";

/**
 * Zooms the view in and out — the vector counterpart of `raster.zoom`
 * (`environments/raster/tools/definitions/zoom.ts`), unchanged behaviour: the
 * shared navigation contract (`../../navigation-types`) and the shared
 * `useCanvasNavigation` (`../../../../canvas-navigation.ts`) mean this file
 * only has to state the zoom-specific numbers, not reinvent the gesture.
 */
const STEP_IN = 1.25, STEP_OUT = 0.8;
const DRAG_RATE = 0.01;

const clickZoom = (context: NavigationContext, gesture: NavigationGesture, at: { x: number; y: number }): void => {
  context.zoomAround(clampZoom(gesture.initial.zoom * (gesture.altKey ? STEP_OUT : STEP_IN)), at.x, at.y, gesture.initial);
};

export default {
  id: "vector.zoom",
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
      context.zoomAround(clampZoom(gesture.initial.zoom * Math.exp(gesture.dx * DRAG_RATE)), gesture.startX, gesture.startY, gesture.initial);
    },
    end: (context, gesture) => {
      if (!gesture.moved) clickZoom(context, gesture, { x: gesture.clientX, y: gesture.clientY });
    },
  },
} satisfies VectorToolDefinition<null> as VectorToolDefinition<null>;
