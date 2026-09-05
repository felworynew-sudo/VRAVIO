import { ellipseOutline } from "../geometry";
import { pathData } from "../path-data";
import type { VectorShape } from "../types";

/**
 * A shape's own outline as SVG path data — the geometry stack's input
 * before any modifier runs. `path` shapes go through unchanged (their
 * bezier handles survive intact); `rectangle` and `ellipse` are flattened
 * into a polygon approximation first, same simplification the boolean-op
 * pipeline already makes at the geometry-port boundary (see
 * `vector-geometry-port.ts`'s own doc comment on why "flatten, then work
 * with straight segments" is this codebase's standing answer to "a
 * modifier needs one canonical path shape to operate on, not five").
 *
 * `line`, `text`, `group`, and `image` return `null` — none of them are a
 * closed fillable outline a modifier stack has anything to act on. A shape
 * with a non-empty `geometry` stack whose kind isn't supported here simply
 * ignores that stack; `env-vector`'s own tests are what would catch a UI
 * that lets someone add a modifier to an unsupported kind, not this
 * function silently doing something to a `text` shape's bounding box.
 */
export function basePathFor(shape: VectorShape): string | null {
  if (shape.kind === "rectangle") {
    if (shape.cornerRadius > 0) {
      const points = roundedRectPoints(shape.x, shape.y, shape.width, shape.height, shape.cornerRadius);
      return pathData(points, true);
    }
    return pathData(
      [{ x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y }, { x: shape.x + shape.width, y: shape.y + shape.height }, { x: shape.x, y: shape.y + shape.height }],
      true,
    );
  }
  if (shape.kind === "ellipse") {
    const outline = ellipseOutline(shape.x + shape.width / 2, shape.y + shape.height / 2, shape.width / 2, shape.height / 2);
    return pathData(outline, true);
  }
  if (shape.kind === "path") return pathData(shape.points, shape.closed);
  return null;
}

/** A plain rectangle is 4 points; a rounded one still needs to be *a*
 * closed polygon for `pathData`, so this reuses the rectangle's own true
 * corner radius via quarter-circle flattening rather than pulling in
 * `roundedRectOutline`'s own steps default silently. */
function roundedRectPoints(x: number, y: number, width: number, height: number, radius: number, steps = 8): { x: number; y: number }[] {
  const r = Math.min(radius, width / 2, height / 2);
  const corner = (cx: number, cy: number, startAngle: number) => {
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const angle = startAngle + (Math.PI / 2) * (i / steps);
      points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    return points;
  };
  return [
    ...corner(x + width - r, y + r, -Math.PI / 2),
    ...corner(x + width - r, y + height - r, 0),
    ...corner(x + r, y + height - r, Math.PI / 2),
    ...corner(x + r, y + r, Math.PI),
  ];
}
