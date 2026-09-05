import { shapeWorldBounds } from "../../shape-ops";
import type { SnapContext, SnapLine, SnapSource } from "../types";

/**
 * The bread-and-butter of "smart guides": every other shape's bounding-box
 * edges and center, in world space — a shape dragged near another's left
 * edge, right edge or horizontal/vertical center snaps to it. Groups are
 * included (their bounds are the union of their children — see
 * `shapeWorldBounds`'s own handling), the same as the selection outline
 * treats them, since a group's outer edge is a real thing to align to even
 * though the group itself is not a paintable shape.
 */
const bounds: SnapSource = {
  id: "bounds",
  collect(context: SnapContext): readonly SnapLine[] {
    const lines: SnapLine[] = [];
    for (const shape of context.shapes) {
      if (context.excludeIds.has(shape.id)) continue;
      const box = shapeWorldBounds(shape, context.shapes, context.measurer);
      if (box.width === 0 && box.height === 0) continue; // an empty group has nothing to align to
      lines.push(
        { axis: "x", value: box.x, kind: "bounds-edge", ownerId: shape.id },
        { axis: "x", value: box.x + box.width, kind: "bounds-edge", ownerId: shape.id },
        { axis: "x", value: box.x + box.width / 2, kind: "bounds-center", ownerId: shape.id },
        { axis: "y", value: box.y, kind: "bounds-edge", ownerId: shape.id },
        { axis: "y", value: box.y + box.height, kind: "bounds-edge", ownerId: shape.id },
        { axis: "y", value: box.y + box.height / 2, kind: "bounds-center", ownerId: shape.id },
      );
    }
    return lines;
  },
};

export default bounds;
