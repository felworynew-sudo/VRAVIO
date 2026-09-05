import { describe, expect, it } from "vitest";
import { createReferenceGeometryPort, type FlatPolygon } from "@vravio/kernel";
import { createWasmGeometryPort } from "./vector-geometry-wasm";

/**
 * Stage 7 of docs/vector-plan.md: "measure how many times faster — write the
 * number down here." The honest number, from this run, is recorded in
 * vector-plan.md's own Stage 7 write-up, not just left in test output — see
 * that file for the actual figures and the (also honest) caveat about what
 * they do and don't mean at this polygon size.
 *
 * This assertion itself only checks the WASM path isn't a *regression* (a
 * generous multiplier on the reference time, same convention as
 * `env-vector/src/performance.bench.test.ts`) — it is not a tight
 * performance contract, since a warm JIT vs. a cold WASM call has enough
 * inherent noise that a strict ratio would be a flaky test for no benefit.
 */
function regularPolygon(sides: number, radius: number, cx: number, cy: number): FlatPolygon {
  const flat = new Float64Array(sides * 2);
  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * Math.PI * 2;
    flat[i * 2] = cx + Math.cos(angle) * radius;
    flat[i * 2 + 1] = cy + Math.sin(angle) * radius;
  }
  return flat;
}

async function fastestOf(fn: () => Promise<unknown>, samples = 20): Promise<number> {
  let best = Infinity;
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("VectorGeometryPort — reference vs WASM, measured", () => {
  it("unions two 64-sided polygons on both implementations", async () => {
    const reference = createReferenceGeometryPort();
    const wasm = createWasmGeometryPort();
    const a = regularPolygon(64, 100, 0, 0);
    const b = regularPolygon(64, 100, 80, 0);

    // Warm the WASM module load (first call pays module fetch/instantiate —
    // that's a one-time app-lifetime cost, not part of the per-call number
    // being measured here) and the reference's own lazy internal state.
    await wasm.booleanOp("union", a, b);
    await reference.booleanOp("union", a, b);

    const referenceTime = await fastestOf(() => Promise.resolve(reference.booleanOp("union", a, b)));
    const wasmTime = await fastestOf(() => Promise.resolve(wasm.booleanOp("union", a, b)));

    // eslint-disable-next-line no-console
    console.log(`[vector-geometry bench] ts-reference: ${referenceTime.toFixed(4)}ms, wasm: ${wasmTime.toFixed(4)}ms, ratio: ${(referenceTime / wasmTime).toFixed(2)}x`);

    const THRESHOLD_MULTIPLIER = 20;
    expect(wasmTime).toBeLessThan(Math.max(referenceTime, 0.05) * THRESHOLD_MULTIPLIER);
  });
});
