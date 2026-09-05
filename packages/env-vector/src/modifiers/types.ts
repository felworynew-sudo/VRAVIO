import type { BooleanOpKind, StrokeJoin as CurveStrokeJoin, VectorCurvePort, VectorGeometryPort } from "@vravio/kernel";

/**
 * Stage 9 of docs/vector-plan.md: "the reason this whole architecture
 * exists" — a shape's geometry is a *stack* of modifiers applied on top of
 * its own base outline, not a single destructive edit. Round a rectangle's
 * corners, offset it, and the rectangle underneath is still a rectangle:
 * go back and change its width, and both modifiers recompute against the
 * new base shape, in order, from scratch.
 *
 * Each modifier kind is its own file in `./kinds`, listed by hand in
 * `./registry.ts` — the same "modifier = file in a directory" catalogue
 * pattern `snapping/registry.ts` already established, and for the same
 * reason: `env-vector` has no Vite build of its own for `import.meta.glob`
 * to discover files with.
 */
export type GeometryModifierKind = "roundCorners" | "offset" | "simplify" | "zigzag" | "boolean";

interface GeometryModifierBase {
  readonly id: string;
  readonly kind: GeometryModifierKind;
  enabled: boolean;
}

export interface RoundCornersModifier extends GeometryModifierBase {
  readonly kind: "roundCorners";
  radius: number;
}

export interface OffsetModifier extends GeometryModifierBase {
  readonly kind: "offset";
  amount: number;
  join: CurveStrokeJoin;
}

export interface SimplifyModifier extends GeometryModifierBase {
  readonly kind: "simplify";
  accuracy: number;
}

export interface ZigzagModifier extends GeometryModifierBase {
  readonly kind: "zigzag";
  amplitude: number;
  segmentLength: number;
}

export interface BooleanModifier extends GeometryModifierBase {
  readonly kind: "boolean";
  op: BooleanOpKind;
  withShapeId: string;
}

export type GeometryModifier = RoundCornersModifier | OffsetModifier | SimplifyModifier | ZigzagModifier | BooleanModifier;

/**
 * What a modifier needs from the outside world to run — injected by the
 * caller (`apps/web`, which owns the lazily-loaded WASM ports) rather than
 * imported directly, so this package stays free of any Vite/bundler
 * dependency. `curvePort`/`geometryPort` are optional because the pure-TS
 * modifiers (`roundCorners`, `zigzag`) never touch them — a caller that
 * only ever uses those two doesn't have to load WASM at all.
 */
export interface ModifierContext {
  readonly curvePort?: VectorCurvePort;
  readonly geometryPort?: VectorGeometryPort;
  /** Resolves another shape's own current base path (its geometry stack
   * NOT applied) for the `boolean` modifier's `withShapeId`. Returns `null`
   * if the shape doesn't exist or has no path this stage supports (see
   * `base-path.ts`). */
  resolveShapePath?(shapeId: string): string | null;
}

/** One modifier's own implementation: given the path *before* this step
 * (`d`, an SVG path-data string — see `base-path.ts` for how a shape's own
 * geometry becomes one), produce the path *after* it. Sync where the work
 * is plain TS (`roundCorners`, `zigzag`); async where it goes through
 * `crates/vector-geometry`'s WASM (`offset`, `simplify`, `boolean`). */
export interface ModifierDefinition<TModifier extends GeometryModifier> {
  readonly kind: TModifier["kind"];
  apply(d: string, modifier: TModifier, context: ModifierContext): string | Promise<string>;
}
