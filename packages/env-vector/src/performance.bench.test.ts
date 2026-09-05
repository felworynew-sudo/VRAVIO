import { describe, expect, it } from "vitest";
import { createShape, createVectorDocument } from "./document";
import { shapeAt } from "./shape-ops";
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
    state.shapes.push(createShape("rectangle", x, y));
  }
  return state;
}

// Every scattered rectangle is 160x100 starting inside [0,1800)x[0,1000), so
// the furthest right/bottom edge either reaches is 1960/1100 — this point is
// outside every one of them regardless of shape count, which is what makes it
// a genuine miss rather than a lucky hit that happens to skip the scan early.
const MISS_X = 5000, MISS_Y = 5000;

describe("performance floor (stage 1 of the vector plan)", () => {
  it("shapeAt misses on 100 shapes — the linear scan this stage is a floor under", () => {
    const state = scatteredDocument(100);

    // A miss walks the whole array, which is shapeAt's worst case and the one
    // an index (stage 4) is meant to fix.
    const elapsed = fastestOf(() => { shapeAt(state, MISS_X, MISS_Y); });

    // Measured on this fixture: ~0.008ms.
    expect(elapsed).toBeLessThan(0.1 * THRESHOLD_MULTIPLIER);
  });

  it("shapeAt misses on 1,000 shapes", () => {
    const state = scatteredDocument(1000);

    const elapsed = fastestOf(() => { shapeAt(state, MISS_X, MISS_Y); });

    // Measured on this fixture: ~0.008ms — indistinguishable from 100 shapes
    // at this size, because 1,000 iterations of a bounds check is still far
    // below where anything but timer resolution shows up. The scan only
    // starts costing something visible at the next size.
    expect(elapsed).toBeLessThan(0.1 * THRESHOLD_MULTIPLIER);
  });

  it("shapeAt misses on 10,000 shapes", () => {
    const state = scatteredDocument(10000);

    const elapsed = fastestOf(() => { shapeAt(state, MISS_X, MISS_Y); });

    // Measured on this fixture: ~0.09ms — visibly above the 100/1,000-shape
    // numbers, which is the linear scan finally showing up. Still comfortably
    // under a frame budget on this fixture; the number stage 4's spatial
    // index exists to keep from growing the moment a document gets larger
    // than this one.
    expect(elapsed).toBeLessThan(1 * THRESHOLD_MULTIPLIER);
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
