import { parseFlatPolygon } from "../svg-path";
import type { BooleanModifier, ModifierDefinition } from "../types";

function pathToFlat(d: string): Float64Array {
  const { points } = parseFlatPolygon(d);
  const flat = new Float64Array(points.length * 2);
  points.forEach((point, i) => { flat[i * 2] = point.x; flat[i * 2 + 1] = point.y; });
  return flat;
}

function flatPolygonsToPath(polygons: readonly Float64Array[]): string {
  return polygons
    .filter((polygon) => polygon.length >= 6)
    .map((polygon) => {
      let d = `M${polygon[0]},${polygon[1]}`;
      for (let i = 2; i < polygon.length; i += 2) d += ` L${polygon[i]},${polygon[i + 1]}`;
      return `${d} Z`;
    })
    .join(" ");
}

/**
 * Delegates to Stage 7's `VectorGeometryPort.booleanOp` — flattens both
 * operands to `boolean_op`'s flat-polygon wire format
 * (`vector-geometry-port.ts`), runs the op, and turns however many output
 * polygons come back into one multi-subpath `d` string (plain SVG: several
 * `M...Z` runs concatenated, rendered with the shape's existing fill rule).
 * `withShapeId`'s own geometry stack is deliberately NOT applied first — a
 * modifier reads the *other* shape's own base outline
 * (`context.resolveShapePath`), not whatever its own modifier stack has
 * turned it into, so two shapes booleaned against each other can't form a
 * recomputation cycle through one another's stacks.
 */
export const booleanModifier: ModifierDefinition<BooleanModifier> = {
  kind: "boolean",
  apply(d, modifier, context) {
    if (!context.geometryPort) throw new Error("boolean modifier requires a VectorGeometryPort — none was provided in ModifierContext");
    if (!context.resolveShapePath) throw new Error("boolean modifier requires resolveShapePath — none was provided in ModifierContext");
    const otherPath = context.resolveShapePath(modifier.withShapeId);
    if (!otherPath) return d; // the other shape is gone or has no usable outline — leave this shape as-is rather than erroring the whole stack
    const run = async () => {
      const result = await context.geometryPort!.booleanOp(modifier.op, pathToFlat(d), pathToFlat(otherPath));
      return flatPolygonsToPath(result);
    };
    return run();
  },
};

export default booleanModifier;
