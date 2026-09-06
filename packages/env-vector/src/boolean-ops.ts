import { applyMatrix } from "./matrix";
import { ellipseOutline, flattenPathOutline, roundedRectOutline, type Point } from "./geometry";
import { worldTransform } from "./tree";
import { createShape } from "./document";
import type { VectorShape, VectorStyle } from "./types";

/**
 * Stage 7's own honest gap, finally reachable from a UI action: the
 * boolean-op engine (`VectorGeometryPort`, `crates/vector-geometry`) has
 * been built, cross-checked against a TS reference, and benchmarked since
 * this same session's earlier pass — but "ни один настоящий вызов булевой
 * операции из UI ещё не существует" (that stage's own write-up) stayed
 * true until now. This file is the missing link: turning a real
 * `VectorShape` into the flat polygon the port actually accepts, and the
 * flat polygon a boolean op returns back into a real shape.
 *
 * `crates/vector-geometry`'s own documented limitations carry through
 * unchanged, on purpose, not quietly narrowed: no holes (a shape that ends
 * up with a hole comes back as a separate outer polygon, same as the
 * engine's own contract), and the result is a straight-edged polygon, not
 * a curve-fitted path — `docs/vector-plan.md` stage 8's own "Обратная
 * аппроксимация полигонов Clipper2 в кривые" write-up already measured,
 * in detail, why that direction is real, separate, unfinished work
 * (`simplify_bezpath`'s angle-preserving simplification cannot collapse a
 * flattened circle back down — a proper `fit_to_bezpath`-based least-
 * squares fit is the honest answer, deferred until this exact moment: a
 * boolean op a UI tool actually calls). A straight-edged Pathfinder result
 * today, honestly labelled as one, beats no Pathfinder at all.
 */

/** A shape's own fill outline, flattened to a closed polygon in *world*
 * space (`worldTransform` applied to every vertex) — the same outline
 * `hitTestShape` already flattens for rectangle/ellipse/path, reused
 * rather than a second curve-to-polygon conversion that could drift from
 * what the shape actually looks like on screen. `null` for a shape kind
 * with no single fill outline of its own (group, instance, image, line,
 * text — the same set `resolveShapePath`/`basePathFor` already exclude
 * for the same reason). */
export function shapeOutlineWorldPolygon(shape: VectorShape, shapes: readonly VectorShape[]): Float64Array | null {
  let local: Point[];
  if (shape.kind === "rectangle") local = roundedRectOutline(shape.x, shape.y, shape.width, shape.height, shape.cornerRadius);
  else if (shape.kind === "ellipse") local = ellipseOutline(shape.x + shape.width / 2, shape.y + shape.height / 2, shape.width / 2, shape.height / 2);
  else if (shape.kind === "path") local = flattenPathOutline(shape.points, true);
  else return null;
  if (local.length < 3) return null;
  const transform = worldTransform(shape, shapes);
  const flat = new Float64Array(local.length * 2);
  local.forEach((point, index) => {
    const world = applyMatrix(transform, point);
    flat[index * 2] = world.x;
    flat[index * 2 + 1] = world.y;
  });
  return flat;
}

/** The inverse direction: a flat world-space polygon (one boolean op's own
 * output piece) back into a real, placeable `path` shape — straight-line
 * points, closed, identity transform (the polygon is already in world/
 * document space, so a fresh shape with no transform of its own places it
 * exactly where the polygon says), the given style (the Pathfinder
 * command's caller decides whose appearance the result inherits — see
 * `applyPathfinderOp`'s own doc comment in `vector-commands.ts`). */
export function pathShapeFromPolygon(polygon: Float64Array, name: string, style: VectorStyle): VectorShape {
  const shape = createShape("path", 0, 0, style);
  if (shape.kind !== "path") throw new Error("createShape(\"path\", ...) did not return a path shape");
  const points = [];
  for (let i = 0; i < polygon.length; i += 2) points.push({ x: polygon[i]!, y: polygon[i + 1]! });
  return { ...shape, points, closed: true, name };
}
