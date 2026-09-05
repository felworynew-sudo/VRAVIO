import { flattenCubic, isStraightSegment } from "../../geometry";
import { applyMatrix } from "../../matrix";
import { worldTransform } from "../../tree";
import type { VectorPoint, VectorShape } from "../../types";
import type { SnapContext, SnapLine, SnapSource } from "../types";

function pointLines(point: { x: number; y: number }, ownerId: string): SnapLine[] {
  return [{ axis: "x", value: point.x, kind: "midpoint", ownerId }, { axis: "y", value: point.y, kind: "midpoint", ownerId }];
}

/** The midpoint of one path segment in local space — the straight-line
 * average for a corner segment, the true point at `t = 0.5` on the curve
 * for a curved one (not the same thing: a curve's midpoint by arc length or
 * by control-point averaging both differ from its `t = 0.5` position, but
 * `t = 0.5` is what "the middle of this segment" means to `flattenCubic`,
 * `pathSegmentBounds` and every other curve function in this package, and a
 * second definition here would just be a second thing to keep in sync). */
function segmentMidpoint(from: VectorPoint, to: VectorPoint): { x: number; y: number } {
  if (isStraightSegment(from, to)) return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const c1 = from.handleOut ? { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y } : from;
  const c2 = to.handleIn ? { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y } : to;
  return flattenCubic(from, c1, c2, to, 2)[1]!; // steps=2 samples exactly t=0, 0.5, 1
}

function localMidpoints(shape: VectorShape): { x: number; y: number }[] {
  if (shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "image") {
    return [
      { x: shape.x + shape.width / 2, y: shape.y }, { x: shape.x + shape.width / 2, y: shape.y + shape.height },
      { x: shape.x, y: shape.y + shape.height / 2 }, { x: shape.x + shape.width, y: shape.y + shape.height / 2 },
    ];
  }
  if (shape.kind === "line") return [{ x: (shape.x1 + shape.x2) / 2, y: (shape.y1 + shape.y2) / 2 }];
  if (shape.kind === "path") {
    const midpoints: { x: number; y: number }[] = [];
    for (let i = 1; i < shape.points.length; i += 1) midpoints.push(segmentMidpoint(shape.points[i - 1]!, shape.points[i]!));
    if (shape.closed && shape.points.length > 1) midpoints.push(segmentMidpoint(shape.points[shape.points.length - 1]!, shape.points[0]!));
    return midpoints;
  }
  return [];
}

/** "Середины сегментов" in docs/vector-plan.md's list — the midpoint of each
 * edge/segment a shape has, in world space. A rectangle's four edge
 * midpoints, a line's own midpoint, and each segment of a path (straight or
 * curved) between its anchors. */
const segmentMidpoints: SnapSource = {
  id: "segment-midpoints",
  collect(context: SnapContext): readonly SnapLine[] {
    const lines: SnapLine[] = [];
    for (const shape of context.shapes) {
      if (context.excludeIds.has(shape.id) || shape.kind === "group") continue;
      const world = worldTransform(shape, context.shapes);
      for (const local of localMidpoints(shape)) lines.push(...pointLines(applyMatrix(world, local), shape.id));
    }
    return lines;
  },
};

export default segmentMidpoints;
