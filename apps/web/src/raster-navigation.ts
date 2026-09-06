import type { RefObject } from "react";
import { useCanvasNavigation as useSharedCanvasNavigation } from "./canvas-navigation";
import { rasterToolById } from "./environments/raster/tools/registry";
import type { DocumentViewport } from "./store";

/**
 * `RasterWorkspace.tsx`'s own navigation wiring — a thin call into the
 * environment-agnostic `useCanvasNavigation` (`./canvas-navigation.ts`, where
 * the real implementation now lives, generalized so `vector-navigation.ts`
 * can share it) supplying raster's own tool lookup and the two tool ids
 * (`raster.hand`/`raster.zoom`) that space, the middle mouse button and the
 * temporary zoom modifier drive. `RasterWorkspace.tsx`'s own import of
 * `useCanvasNavigation` from this file is unchanged by the move.
 */
export function useCanvasNavigation(params: {
  documentId: string;
  workspaceRef: RefObject<HTMLDivElement | null>;
  viewport: DocumentViewport;
  activeToolId: string | undefined;
  toolOptions: Record<string, Record<string, string | number | boolean>>;
  documentWidth: number;
  documentHeight: number;
}) {
  return useSharedCanvasNavigation({ ...params, toolById: rasterToolById, zoomToolId: "raster.zoom", handToolId: "raster.hand" });
}
