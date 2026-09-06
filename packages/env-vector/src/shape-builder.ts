import type { FlatPolygon, VectorGeometryPort } from "@vravio/kernel";
import { pointInPolygon } from "./geometry";

/**
 * Illustrator's/Inkscape's Shape Builder — real behaviour checked against
 * Inkscape's own source before implementing anything here (CLAUDE.md §1),
 * not re-derived from the name alone: `src/ui/tools/booleans-tool.cpp` and
 * `booleans-subitems.cpp` (gitlab.com/inkscape/inkscape, GPL — read for
 * behaviour, not copied, same caveat `docs/vector-plan.md`'s own donor
 * list already carries for this exact repository). On activation, Inkscape
 * "fractures" the whole selection into every non-overlapping region formed
 * by the shapes' outlines (`SubItem::build_mosaic`, via a planar cut of a
 * bounding rectangle by every outline — `pathvector_cut`), keeping track of
 * which original item(s) each region belongs to; a drag then merges
 * (default) or erases (Alt) whichever regions the pointer crossed.
 *
 * `crates/vector-geometry`'s WASM port has no general planar-arrangement
 * primitive (`pathvector_cut`'s own job) — only pairwise `union`/
 * `subtract`/`intersect`/`exclude` (`boolean-ops.ts`, already wired to the
 * Pathfinder command). Rather than write a new arrangement algorithm from
 * scratch, `buildFaces` below gets the exact same *result* — every
 * non-overlapping region, correctly attributed to its source shape(s) — by
 * incrementally refining a face list with the existing pairwise ops one
 * shape at a time: for each new shape S, every existing face splits into
 * "inside S" (gets S appended to its owners) and "outside S" (keeps its
 * owners), and whatever part of S is not inside any existing face becomes
 * a brand new face owned by S alone. This is the standard incremental
 * technique for building a map overlay out of pairwise boolean primitives
 * when no arrangement/sweep-line primitive is available — not invented for
 * this file, just applied here — and it inherits `crates/vector-geometry`'s
 * own documented limitations (no holes, straight edges) exactly the way
 * Pathfinder already does.
 *
 * Shapes are expected topmost-first (`polygons[0]` is the frontmost) —
 * `ShapeBuilderFace.sourceIds[0]` then always names whichever original
 * shape should own the merged result's style, the same "topmost wins"
 * convention Pathfinder's own `applyPathfinderOp` already uses
 * (`shapes[0]!.style`).
 */
export interface ShapeBuilderFace {
  readonly polygon: FlatPolygon;
  /** Original shape ids whose area covers this face, topmost source first. */
  readonly sourceIds: readonly string[];
}

export async function buildShapeBuilderFaces(port: VectorGeometryPort, polygons: readonly { id: string; polygon: FlatPolygon }[]): Promise<ShapeBuilderFace[]> {
  if (polygons.length === 0) return [];
  let faces: ShapeBuilderFace[] = [{ polygon: polygons[0]!.polygon, sourceIds: [polygons[0]!.id] }];
  for (let index = 1; index < polygons.length; index += 1) {
    const { id, polygon } = polygons[index]!;
    const nextFaces: ShapeBuilderFace[] = [];
    const covered: FlatPolygon[] = [];
    for (const face of faces) {
      const inside = await port.booleanOp("intersect", face.polygon, polygon);
      for (const piece of inside) nextFaces.push({ polygon: piece, sourceIds: [...face.sourceIds, id] });
      covered.push(...inside);
      const outside = await port.booleanOp("subtract", face.polygon, polygon);
      for (const piece of outside) nextFaces.push({ polygon: piece, sourceIds: face.sourceIds });
    }
    // Whatever part of this shape no existing face already covers is a
    // brand new face, owned by this shape alone — cut away everything the
    // loop above already attributed to some earlier (higher) shape.
    let remainder: FlatPolygon[] = [polygon];
    for (const piece of covered) {
      const next: FlatPolygon[] = [];
      for (const candidate of remainder) next.push(...await port.booleanOp("subtract", candidate, piece));
      remainder = next;
    }
    for (const piece of remainder) nextFaces.push({ polygon: piece, sourceIds: [id] });
    faces = nextFaces;
  }
  return faces;
}

/** Ray-casting against a flat `[x0, y0, x1, y1, ...]` polygon — the same
 * `pointInPolygon` every shape hit-test already uses, adapted for the flat
 * array shape a boolean-op result comes back in rather than a second,
 * independently written point-in-polygon test. */
export function faceContainsPoint(polygon: FlatPolygon, x: number, y: number): boolean {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < polygon.length; i += 2) points.push({ x: polygon[i]!, y: polygon[i + 1]! });
  return pointInPolygon(points, { x, y });
}

/** Merges the polygons of every face in `indices` into one (or more, if
 * they do not all touch) result polygon — chained pairwise union, the same
 * "no primitive takes more than two polygons" fold `applyPathfinderOp`
 * already does for its own multi-shape selections. */
export async function unionFaces(port: VectorGeometryPort, faces: readonly ShapeBuilderFace[], indices: readonly number[]): Promise<FlatPolygon[]> {
  if (indices.length === 0) return [];
  let pieces: FlatPolygon[] = [faces[indices[0]!]!.polygon];
  for (let i = 1; i < indices.length; i += 1) {
    const next: FlatPolygon[] = [];
    for (const piece of pieces) next.push(...await port.booleanOp("union", piece, faces[indices[i]!]!.polygon));
    pieces = next;
  }
  return pieces;
}
