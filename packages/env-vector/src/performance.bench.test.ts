import { describe, expect, it } from "vitest";
import { createShape, createVectorDocument } from "./document";
import { shapeAt } from "./shape-ops";
import { makeVectorOrderKey } from "./types";
import type { VectorDocumentState } from "./types";

/**
 * Stage 1 of docs/vector-plan.md: a measured floor under what the vector
 * environment already does, before any of that plan's changes begin.
 *
 * These are not aspirational numbers — each threshold is the measured time on
 * this machine times a generous multiplier, the same convention
 * `env-raster/src/performance.bench.test.ts` uses and for the same reason: a
 * fixed millisecond number is honest about a specific machine on a specific
 * day, and a multiplier keeps a slower CI box or a cold JIT from failing the
 * suite while still catching a real regression (the linear scan this stage
 * is about to replace with an index, for instance, coming back by accident).
 *
 * If a later stage's index makes one of these numbers better, lower the
 * threshold in that stage's own commit — that is the improvement being
 * measured, not a reason to leave the old floor in place pretending nothing
 * changed.
 */
const THRESHOLD_MULTIPLIER = 6;

function fastestOf(fn: () => void, samples = 5): number {
  let best = Infinity;
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * A document with `count` shapes scattered across a 1920x1080 canvas — sized
 * and positioned like actual placed objects, not stacked at the origin,
 * because `shapeAt` has to reject most of them on a miss and a stack at (0,0)
 * would make every rectangle's bounds test resolve on the same cache line.
 */
function scatteredDocument(count: number): VectorDocumentState {
  const state = createVectorDocument(1920, 1080);
  for (let index = 0; index < count; index += 1) {
    const x = (index * 227) % 1800, y = (index * 311) % 1000;
    const shape = createShape("rectangle", x, y);
    // A direct orderKey assignment rather than addShape/appendShapeAt: both of
    // those scan existing siblings on every call, which would make this setup
    // loop itself O(n²) at 10,000 shapes. What this benchmark needs from the
    // fixture is realistic, distinct order keys — not the general insertion
    // path, which has its own tests in group-ops.test.ts and vector.test.ts.
    (shape as { orderKey: string }).orderKey = makeVectorOrderKey(index);
    state.shapes.push(shape);
  }
  return state;
}

// Every scattered rectangle is 160x100 starting inside [0,1800)x[0,1000), so
// the furthest right/bottom edge either reaches is 1960/1100 — this point is
// outside every one of them regardless of shape count, which is what makes it
// a genuine miss rather than a lucky hit that happens to skip the scan early.
const MISS_X = 5000, MISS_Y = 5000;

describe("performance floor (stage 1 of the vector plan)", () => {
  /**
   * These three thresholds were re-measured after stage 2 added transform
   * composition to `shapeAt` — 100/1,000/10,000 shapes went from
   * ~0.008/0.008/0.09ms (stage 1's numbers, a plain bounds check) to
   * ~0.17/0.81/3.4ms. That is a real, deliberate cost, not a regression to
   * chase down: every shape a miss walks past now gets `worldTransform`
   * (an ancestor-chain matrix multiply) and a matrix inversion before its
   * bounds are even tested, because correctness for a shape sitting inside a
   * rotated group requires it (see `shapeAt`'s own doc comment). Stage 4's
   * spatial index removes most of this work for a miss by not visiting most
   * shapes at all, which is the number that should come back down — lowering
   * these thresholds is that stage's job, not a reason to avoid correct
   * transform handling now.
   */
  it("shapeAt misses on 100 shapes — the linear scan this stage is a floor under", () => {
    const state = scatteredDocument(100);

    // A miss walks the whole array, which is shapeAt's worst case and the one
    // an index (stage 4) is meant to fix.
    const elapsed = fastestOf(() => { shapeAt(state, MISS_X, MISS_Y); });

    // Measured on this fixture: ~0.17ms.
    expect(elapsed).toBeLessThan(0.2 * THRESHOLD_MULTIPLIER);
  });

  it("shapeAt misses on 1,000 shapes", () => {
    const state = scatteredDocument(1000);

    const elapsed = fastestOf(() => { shapeAt(state, MISS_X, MISS_Y); });

    // Measured on this fixture: ~0.81ms.
    expect(elapsed).toBeLessThan(0.9 * THRESHOLD_MULTIPLIER);
  });

  it("shapeAt misses on 10,000 shapes", () => {
    const state = scatteredDocument(10000);

    const elapsed = fastestOf(() => { shapeAt(state, MISS_X, MISS_Y); });

    // Measured on this fixture: ~3.4ms — comfortably under a frame budget
    // still, but ten times the shapes for roughly four times the time (rather
    // than ten) suggests the per-shape matrix work, not the O(n) scan itself,
    // now dominates at these sizes. Either way, this is exactly the number
    // stage 4's spatial index exists to bring down by visiting far fewer
    // shapes per query.
    expect(elapsed).toBeLessThan(4 * THRESHOLD_MULTIPLIER);
  });

  it("serializes a 1,000-shape document — the cost autosave and session restore pay", () => {
    const state = scatteredDocument(1000);

    // The real autosave path (document-snapshot-store.ts's serializeDocument)
    // does the same JSON.stringify of document.state, plus a pass that pulls
    // typed-array binaries out by reference — a fixed cost independent of
    // shape count. A vector document has no binaries of its own (an `image`
    // shape only holds a reference into the asset store), so stringifying the
    // state directly measures the part that actually scales with shape count,
    // without needing to construct a full VravioDocument for this test.
    const elapsed = fastestOf(() => { JSON.parse(JSON.stringify(state)); });

    // Measured on this fixture: ~2.2ms.
    expect(elapsed).toBeLessThan(2.2 * THRESHOLD_MULTIPLIER);
  });
});
