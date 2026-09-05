import { applyMatrix } from "../../matrix";
import { worldTransform } from "../../tree";
import type { VectorShape } from "../../types";
import type { SnapContext, SnapLine, SnapSource } from "../types";

/** A world-space point contributes two lines, not one — aligning either its
 * x or its y is a legitimate snap on its own (dragging a shape so its own
 * corner lines up *vertically* with another shape's corner, say, with no
 * requirement that the y coordinates match too). */
function pointLines(point: { x: number; y: number }, ownerId: string): SnapLine[] {
  return [{ axis: "x", value: point.x, kind: "node", ownerId }, { axis: "y", value: point.y, kind: "node", ownerId }];
}

/** The corner/endpoint/anchor points a shape actually has, in its own local
 * space — kept separate from turning them into world-space `SnapLine`s so a
 * future consumer (a "smart guide to this exact anchor" UI, say) can reuse
 * the local points without recomputing them. */
function localAnchors(shape: VectorShape): { x: number; y: number }[] {
  if (shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "image") {
    return [{ x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y }, { x: shape.x, y: shape.y + shape.height }, { x: shape.x + shape.width, y: shape.y + shape.height }];
  }
  if (shape.kind === "line") return [{ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }];
  if (shape.kind === "path") return shape.points.map((point) => ({ x: point.x, y: point.y }));
  return []; // text and group have no anchor points of their own worth snapping to
}

/**
 * Every shape's own corner/endpoint/path-anchor points, in world space —
 * "узлы" in docs/vector-plan.md's list. Ellipse cardinal points (its own
 * bbox corners rather than points actually on its curve) are a deliberate
 * simplification: the four points a user visually reads as "the ellipse's
 * extent" are exactly its bbox corners' x/y values recombined, which
 * `bounds.ts`'s edges already provide — a true point *on* the ellipse's
 * curve is not a corner and is left for a later stage's curve-aware work.
 */
const nodes: SnapSource = {
  id: "nodes",
  collect(context: SnapContext): readonly SnapLine[] {
    const lines: SnapLine[] = [];
    for (const shape of context.shapes) {
      if (context.excludeIds.has(shape.id) || shape.kind === "group") continue;
      const world = worldTransform(shape, context.shapes);
      for (const local of localAnchors(shape)) lines.push(...pointLines(applyMatrix(world, local), shape.id));
    }
    return lines;
  },
};

export default nodes;
