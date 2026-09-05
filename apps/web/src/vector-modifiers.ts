import { useEffect, useState } from "react";
import { applyModifierStack, basePathFor, type ModifierContext, type VectorDocumentState } from "@vravio/env-vector";
import { createWasmCurvePort, createWasmGeometryPort } from "./vector-geometry-wasm";

/**
 * Stage 9 of docs/vector-plan.md's cache-by-revision requirement: "round a
 * rectangle, offset it, go back and change its width — everything
 * recomputes" needs the reverse to hold just as much — a revision that
 * *didn't* touch a shape's base geometry or its modifier stack shouldn't
 * pay to recompute it on every re-render. `document.revision` is the same
 * coarse invalidation signal `VectorWorkspace.tsx`'s own spatial index
 * already keys off of (see its `useMemo`) — one recompute per edit, not
 * one per frame, and a genuinely different result every time the source
 * actually changed.
 *
 * The two WASM-backed modifiers (`offset`, `simplify`, `boolean`) are why
 * this can't be a plain `useMemo`: their result isn't available
 * synchronously during render. Until the effect below resolves, a shape
 * with modifiers falls back to rendering its own unmodified base geometry
 * — never a blank shape, never a stale one from a previous shape's edit.
 */
let sharedCurvePort: ReturnType<typeof createWasmCurvePort> | null = null;
let sharedGeometryPort: ReturnType<typeof createWasmGeometryPort> | null = null;
function sharedPorts() {
  sharedCurvePort ??= createWasmCurvePort();
  sharedGeometryPort ??= createWasmGeometryPort();
  return { curvePort: sharedCurvePort, geometryPort: sharedGeometryPort };
}

export function useModifierResults(state: VectorDocumentState, revision: number): ReadonlyMap<string, string> {
  const [results, setResults] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const shapesWithModifiers = state.shapes.filter((shape) => shape.geometry.length > 0);
    if (!shapesWithModifiers.length) {
      setResults(new Map());
      return;
    }
    let cancelled = false;
    const context: ModifierContext = {
      ...sharedPorts(),
      resolveShapePath: (shapeId) => {
        const other = state.shapes.find((shape) => shape.id === shapeId);
        return other ? basePathFor(other) : null;
      },
    };
    Promise.all(
      shapesWithModifiers.map(async (shape) => [shape.id, await applyModifierStack(shape, shape.geometry, context)] as const),
    ).then((entries) => {
      if (cancelled) return;
      const map = new Map<string, string>();
      for (const [id, path] of entries) if (path !== null) map.set(id, path);
      setResults(map);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on revision exactly like the spatial index's own useMemo, not on `state` itself
  }, [revision]);

  return results;
}
