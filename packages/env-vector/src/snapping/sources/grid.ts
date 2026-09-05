import type { SnapContext, SnapLine, SnapSource } from "../types";

/**
 * The simplest snap source: a line at every multiple of the grid spacing,
 * both axes, bounded to the document. `null` spacing (the common case —
 * grid snapping is opt-in) collects nothing rather than a grid at some
 * arbitrary default the user never asked for.
 */
const grid: SnapSource = {
  id: "grid",
  collect(context: SnapContext): readonly SnapLine[] {
    if (!context.gridSpacing || context.gridSpacing <= 0) return [];
    const lines: SnapLine[] = [];
    for (let x = 0; x <= context.documentWidth; x += context.gridSpacing) lines.push({ axis: "x", value: x, kind: "grid" });
    for (let y = 0; y <= context.documentHeight; y += context.gridSpacing) lines.push({ axis: "y", value: y, kind: "grid" });
    return lines;
  },
};

export default grid;
