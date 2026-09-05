import { layerAccepts, layerLockReason, type LayerAction } from "@vravio/env-raster";
import { diagnostic } from "../../../diagnostics";
import type { ToolContext } from "./types";

/**
 * Whether the active layer's locks refuse this gesture before it starts.
 *
 * `RasterWorkspace.tsx` still says "locks are checked once, here, rather than
 * in each tool" — and that was true until stage 5 moved the tools into the
 * catalogue, because the catalogue dispatch above it returns before that check
 * is ever reached. Every migrated tool was left reading `activeLayer.locked`
 * instead, which is Lock All alone: a layer with only "lock pixels" set
 * accepted the gesture, painted it live to the canvas, and had it refused by
 * the rules at commit time. The stroke appeared and then vanished, and on the
 * paths that repaint nothing it appeared and then stayed, showing pixels the
 * document never took (fixed alongside this in `raster-commit.ts`).
 *
 * This does not replace the rules as the enforcement — `lock-pixels` refuses
 * the edit at the commit door whether a tool asks this or not, which is the
 * point of having a door. This is a tool declining to begin a gesture it
 * already knows cannot land, and saying why, so the refusal is immediate
 * rather than a stroke the user watches disappear.
 *
 * Not for a tool that creates its own layer rather than writing into the
 * active one: `shape.tsx` is unaffected by a lock on whatever happens to be
 * selected, and keeps its own Lock All check.
 */
export function locksRefuse(context: ToolContext<unknown>, action: LayerAction, toolId: string): boolean {
  // A mask is not the layer's own pixels — the same exemption the mask rule
  // and the workspace's own `maskTarget` check already make.
  if (context.paintTarget.kind === "mask") return false;
  const layer = context.activeLayer;
  if (!layer || layerAccepts(layer, action)) return false;
  diagnostic("info", "layer.locked", layerLockReason(layer, action) ?? "Layer is locked", { layerId: layer.id, tool: toolId });
  return true;
}
