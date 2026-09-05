import RBush from "rbush";
import { applyMatrix, invertMatrix } from "./matrix";
import { type TextMeasurer, type VectorBounds, hitTestShape, shapeWorldBounds } from "./shape-ops";
import { flattenVectorShapes, isShapeEffectivelyLocked, isShapeEffectivelyVisible, worldTransform } from "./tree";
import type { VectorShape } from "./types";

interface IndexedEntry { id: string; minX: number; minY: number; maxX: number; maxY: number }

/**
 * `shapeAt`'s linear scan (`shape-ops.ts`) stays exactly as it is — it is the
 * reference implementation this file's `shapeAtIndexed` is tested against
 * (`spatial-index.test.ts`'s "index and linear scan agree" property test),
 * and every existing caller that has no cached index to hand keeps working
 * unchanged. This is the fast path *on top of* it: an R-tree over each
 * shape's world bounds narrows "which shape is under this point" from "every
 * shape" (stage 1's measured floor: ~3.4ms at 10,000 shapes) to "the handful
 * whose bounding box actually contains the point" — see stage 4's numbers in
 * docs/vector-plan.md.
 *
 * Building one costs a full pass over the document — the same O(n) stage 1's
 * benchmark already pays for `flattenVectorShapes`'s paint order and for
 * computing every shape's world bounds. What changes is that this pass now
 * happens *once per document revision* (a caller memoises it, keyed on the
 * document's own revision counter — see `VectorWorkspace.tsx`), not once per
 * pointer move.
 */
export interface ShapeSpatialIndex {
  readonly tree: RBush<IndexedEntry>;
  /** id → position in paint order (`flattenVectorShapes`), higher is more on
   * top — lets `shapeAtIndexed` pick the topmost of a handful of candidates
   * without re-walking the whole tree. */
  readonly paintOrder: ReadonlyMap<string, number>;
  /** Each shape's own world bounds, computed once while building the index —
   * reused by the selection outline (`shapeWorldBoundsIndexed`) so drawing it
   * does not redo the same ancestor-transform walk `search` already paid for. */
  readonly bounds: ReadonlyMap<string, VectorBounds>;
}

export function buildShapeSpatialIndex(shapes: readonly VectorShape[], measurer?: TextMeasurer): ShapeSpatialIndex {
  const painted = flattenVectorShapes(shapes);
  const paintOrder = new Map(painted.map((shape, index) => [shape.id, index]));
  const bounds = new Map<string, VectorBounds>();
  const entries: IndexedEntry[] = [];
  for (const shape of shapes) {
    const box = shapeWorldBounds(shape, shapes, measurer);
    bounds.set(shape.id, box);
    // A group has no visual of its own (shapeWorldBounds already returns the
    // union of its children for it) and is never a hit-test target — see
    // shapeAt's own reasoning for skipping it. Indexing it too would only
    // ever produce a candidate shapeAtIndexed immediately discards.
    if (shape.kind === "group") continue;
    if (!isShapeEffectivelyVisible(shape, shapes) || isShapeEffectivelyLocked(shape, shapes)) continue;
    entries.push({ id: shape.id, minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height });
  }
  const tree = new RBush<IndexedEntry>();
  tree.load(entries);
  return { tree, paintOrder, bounds };
}

/** The indexed counterpart of `shapeAt` — same contract (topmost visible,
 * unlocked, non-group shape under a document-space point, `null` on a
 * miss), reached by testing only the R-tree's candidates for this point
 * rather than every shape in the document. */
export function shapeAtIndexed(index: ShapeSpatialIndex, shapes: readonly VectorShape[], x: number, y: number, measurer?: TextMeasurer): VectorShape | null {
  const candidateIds = index.tree.search({ minX: x, minY: y, maxX: x, maxY: y });
  if (!candidateIds.length) return null;
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const ordered = candidateIds
    .map((entry) => byId.get(entry.id))
    .filter((shape): shape is VectorShape => Boolean(shape))
    .sort((a, b) => (index.paintOrder.get(b.id) ?? -1) - (index.paintOrder.get(a.id) ?? -1));
  for (const shape of ordered) {
    const inverse = invertMatrix(worldTransform(shape, shapes));
    if (!inverse) continue;
    const local = applyMatrix(inverse, { x, y });
    if (hitTestShape(shape, local.x, local.y, measurer)) return shape;
  }
  return null;
}

/** Every shape whose world bounds intersect a document-space rectangle —
 * the R-tree's other natural query, for a future marquee/rubber-band select.
 * No vector tool drives a marquee yet (only click-select exists), so this is
 * infrastructure ahead of its consumer rather than something exercised live
 * today; it is tested here on its own terms. */
export function shapesInRect(index: ShapeSpatialIndex, shapes: readonly VectorShape[], rect: VectorBounds): VectorShape[] {
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const hits = index.tree.search({ minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height });
  return hits.map((entry) => byId.get(entry.id)).filter((shape): shape is VectorShape => Boolean(shape));
}

/** A shape's world bounds as the index already computed them — for the
 * selection outline, so drawing it does not repeat `shapeWorldBounds`'s own
 * ancestor-chain walk a second time in the same frame the index was built. */
export function shapeWorldBoundsIndexed(index: ShapeSpatialIndex, id: string): VectorBounds | undefined {
  return index.bounds.get(id);
}
