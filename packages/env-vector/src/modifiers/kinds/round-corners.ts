import { parseFlatPolygon } from "../svg-path";
import type { ModifierDefinition, RoundCornersModifier } from "../types";

/**
 * Replaces every sharp vertex with a quadratic-curve fillet of `radius` —
 * cut back along each of the vertex's two edges by `radius` (or half the
 * edge's own length, whichever is shorter, so two fillets on a short edge
 * never overlap past each other), then curve through the original vertex
 * as the quadratic's control point.
 */
function roundCorner(prev: { x: number; y: number }, vertex: { x: number; y: number }, next: { x: number; y: number }, radius: number): { before: { x: number; y: number }; after: { x: number; y: number } } {
  const toPrev = { x: prev.x - vertex.x, y: prev.y - vertex.y };
  const toNext = { x: next.x - vertex.x, y: next.y - vertex.y };
  const prevLength = Math.hypot(toPrev.x, toPrev.y) || 1;
  const nextLength = Math.hypot(toNext.x, toNext.y) || 1;
  const cutPrev = Math.min(radius, prevLength / 2);
  const cutNext = Math.min(radius, nextLength / 2);
  return {
    before: { x: vertex.x + (toPrev.x / prevLength) * cutPrev, y: vertex.y + (toPrev.y / prevLength) * cutPrev },
    after: { x: vertex.x + (toNext.x / nextLength) * cutNext, y: vertex.y + (toNext.y / nextLength) * cutNext },
  };
}

export const roundCorners: ModifierDefinition<RoundCornersModifier> = {
  kind: "roundCorners",
  apply(d, modifier) {
    const { points, closed } = parseFlatPolygon(d);
    if (points.length < 3 || modifier.radius <= 0) return d;
    const count = points.length;
    const cuts = points.map((point, index) => {
      const prev = points[(index - 1 + count) % count]!;
      const next = points[(index + 1) % count]!;
      // An open path's two endpoints have no "other side" to fillet — left as sharp corners.
      if (!closed && (index === 0 || index === count - 1)) return null;
      return roundCorner(prev, point, next, modifier.radius);
    });

    let path = "";
    const firstCut = cuts[0];
    path += firstCut ? `M${firstCut.before.x},${firstCut.before.y}` : `M${points[0]!.x},${points[0]!.y}`;
    for (let i = 0; i < count; i += 1) {
      const nextIndex = (i + 1) % count;
      if (!closed && nextIndex === 0) break;
      const cut = cuts[i];
      if (cut) path += ` Q${points[i]!.x},${points[i]!.y} ${cut.after.x},${cut.after.y}`;
      const nextCut = cuts[nextIndex];
      const lineTo = nextCut ? nextCut.before : points[nextIndex]!;
      path += ` L${lineTo.x},${lineTo.y}`;
    }
    if (closed) path += " Z";
    return path;
  },
};

export default roundCorners;
