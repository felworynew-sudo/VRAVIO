import type { VectorToolDefinition } from "../types";

/**
 * Drags the view around — the vector counterpart of `raster.hand`
 * (`environments/raster/tools/definitions/hand.ts`), same file almost to the
 * letter: the navigation contract is shared (`../../navigation-types`)
 * precisely so this does not have to be reinvented per environment.
 *
 * The whole tool: pan by however far the pointer has travelled, from where
 * the viewport stood when the drag began. Screen pixels, one to one, at any
 * zoom — the picture follows the hand exactly, which is the only thing this
 * tool has ever had to get right.
 *
 * Also what the space bar and the middle mouse button run in the vector
 * workspace, without becoming the active tool — see `useCanvasNavigation` in
 * `../../../canvas-navigation.ts`.
 */
export default {
  id: "vector.hand",
  createState: () => null,
  navigation: {
    begin: () => "drag",
    move: (context, gesture) => context.setViewport({ panX: gesture.initial.panX + gesture.dx, panY: gesture.initial.panY + gesture.dy, mode: "custom" }),
  },
} satisfies VectorToolDefinition<null> as VectorToolDefinition<null>;
