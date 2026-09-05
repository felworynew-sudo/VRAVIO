import { floodFill, parseHexColor } from "@vravio/env-raster";
import type { RasterToolDefinition } from "../types";
import { locksRefuse } from "../lock-guard";

/**
 * The paint bucket: a contiguous flood fill from the pixel clicked.
 *
 * Second tool moved out of RasterWorkspace's switch (stage 5 of
 * docs/migration-plan.md), and the first that writes. Picked to go first
 * among the writing tools because it is a single click rather than a
 * dragged stroke — the whole edit is `onPointerDown` — so it exercises
 * `ctx.commit` on its own, without also depending on the drag machinery a
 * brush needs. That was ToolContext's least-evidenced member as of stage 4;
 * this is what tests it for real.
 *
 * Pencil, brush, highlighter and eraser are not next in line for the same
 * reason fill went ahead of them: in RasterWorkspace today they are one
 * shared code path (gesture tracking, curve smoothing, coalesced pointer
 * events) parameterised per tool, not five independent branches. Porting
 * one of them alone would mean either duplicating that shared machinery
 * into a single tool file or leaving the rest half-migrated with the
 * pipeline split across two places — the double-maintenance CONTRIBUTING.md
 * warns against. They move together, as their own piece of work.
 */

const fill: RasterToolDefinition<null> = {
  id: "raster.fill",
  // Was in RASTER_ONLY_TOOLS before this moved here — filling a text or
  // adjustment layer needs a real pixel buffer to flood-fill, not the
  // cached preview those kinds carry.
  requiresRasterized: true,
  createState: () => null,

  onPointerDown(context, pointer) {
    if (locksRefuse(context, "paint", "raster.fill")) return;

    const before = context.targetPixels();
    const after = before.slice();
    const { document } = context;
    const tolerance = Number(context.options.tolerance ?? 32);

    const changed = floodFill(after, document.width, document.height, pointer.point.x, pointer.point.y, parseHexColor(context.paintColor), tolerance, context.paintMask);
    if (!changed) return;

    const label = context.paintTarget.kind === "mask" ? "Fill Layer Mask (Заливка маски слоя)" : "Paint Bucket (Заливка)";
    void context.commit(before, after, label);
  },
};

export default fill;
