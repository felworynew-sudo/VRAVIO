import type { VectorPoint } from "./types";

/** An SVG path `d` string that uses a cubic bezier (`C`) between two points whenever either
 * carries a handle, and a straight line otherwise — a path can freely mix smooth and corner
 * points, exactly like Illustrator's. Shared between the SVG canvas (which renders it directly)
 * and anything that rasterizes a document (which can feed the same string to a canvas 2D
 * context's Path2D — `d` attribute syntax is exactly what Path2D's constructor takes). */
export function pathData(points: readonly VectorPoint[], closed: boolean): string {
  if (!points.length) return "";
  const segment = (from: VectorPoint, to: VectorPoint): string => {
    if (!from.handleOut && !to.handleIn) return `L${to.x} ${to.y}`;
    const c1 = from.handleOut ? { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y } : from;
    const c2 = to.handleIn ? { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y } : to;
    return `C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`;
  };
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length; index += 1) d += ` ${segment(points[index - 1]!, points[index]!)}`;
  if (closed && points.length > 1) d += ` ${segment(points[points.length - 1]!, points[0]!)} Z`;
  else if (closed) d += " Z";
  return d;
}
