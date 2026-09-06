import type { RefObject } from "react";
import { useCanvasNavigation } from "./canvas-navigation";
import { vectorToolById } from "./environments/vector/tools/registry";
import type { DocumentViewport } from "./store";

/**
 * `VectorWorkspace.tsx`'s own navigation wiring — the vector counterpart of
 * `raster-navigation.ts`, both thin calls into the shared implementation in
 * `./canvas-navigation.ts`. Supplies vector's own tool lookup and the two
 * tool ids (`vector.hand`/`vector.zoom`) added alongside this file so the
 * vector environment gets the same space-bar-hand, middle-mouse-hand,
 * scrubby-zoom and zoom-anchored-on-cursor behaviour raster already had —
 * previously vector only had a plain wheel-to-pan/zoom with no dedicated
 * tools and no cursor-anchored zoom at all.
 */
export function useVectorCanvasNavigation(params: {
  documentId: string;
  workspaceRef: RefObject<HTMLDivElement | null>;
  viewport: DocumentViewport;
  activeToolId: string | undefined;
  toolOptions: Record<string, Record<string, string | number | boolean>>;
  documentWidth: number;
  documentHeight: number;
}) {
  return useCanvasNavigation({ ...params, toolById: vectorToolById, zoomToolId: "vector.zoom", handToolId: "vector.hand", disableFit: true });
}
