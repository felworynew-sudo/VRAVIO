import * as polygonClipping from "polygon-clipping";
import type { BooleanOpKind, FlatPolygon, VectorGeometryPort } from "./vector-geometry-port";

type Ring = [number, number][];
type Polygon = Ring[];

function toRing(flat: FlatPolygon): Ring {
  const ring: Ring = [];
  for (let i = 0; i < flat.length; i += 2) ring.push([flat[i]!, flat[i + 1]!]);
  return ring;
}

function fromRing(ring: readonly (readonly number[])[]): FlatPolygon {
  const flat = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i += 1) {
    flat[i * 2] = ring[i]![0]!;
    flat[i * 2 + 1] = ring[i]![1]!;
  }
  return flat;
}

const opFns: Record<BooleanOpKind, (a: Polygon, b: Polygon) => Polygon[]> = {
  union: polygonClipping.union,
  subtract: polygonClipping.difference,
  intersect: polygonClipping.intersection,
  exclude: polygonClipping.xor,
};

/**
 * The "reference, slow" half of Stage 7 — `polygon-clipping` (a
 * battle-tested pure-JS implementation of the Martinez-Rueda algorithm)
 * rather than a hand-rolled one, same call this codebase already made for
 * the spatial index (`rbush`, not a hand-rolled R-tree): a home-grown
 * general polygon clipper is exactly the kind of thing that looks done long
 * before it's actually correct, and "reference implementation" only means
 * something if it's trustworthy on its own.
 */
export function createReferenceGeometryPort(): VectorGeometryPort {
  return {
    name: "ts-reference",
    booleanOp(kind, subject, clip) {
      const result = opFns[kind]([toRing(subject)], [toRing(clip)]);
      // Exterior ring only per output polygon — holes are the documented
      // gap in vector-geometry-port.ts, matched by the WASM side.
      return result.map((polygon) => fromRing(polygon[0] ?? []));
    },
  };
}
