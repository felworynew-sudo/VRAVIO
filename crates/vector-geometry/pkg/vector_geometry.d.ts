/* tslint:disable */
/* eslint-disable */

export function boolean_op(kind: string, subject: Float64Array, clip: Float64Array): Float64Array;

/**
 * Grows (positive `amount`) or shrinks (negative) a filled shape by a
 * uniform distance — the "offset path" bullet. `tolerance` is Kurbo's own
 * accuracy knob for how closely the (possibly curved) joins approximate
 * the true offset curve; it is not a node-count knob the way `simplify`'s
 * `accuracy` is.
 */
export function offset_path(d: string, amount: number, join: string, tolerance: number): string;

/**
 * Reduces the number of nodes in a path while staying within `accuracy` of
 * the original shape — genuinely redundant points (near-collinear runs, a
 * hand-drawn path with far more samples than its actual curvature needs)
 * collapse a lot; a real corner never does, on purpose (`SimplifyOptions`'
 * default angle threshold treats any non-negligible turn as an intentional
 * corner to preserve exactly, not noise to smooth away).
 *
 * That preserve-corners default is *not* enough, on its own, to satisfy
 * this stage's other bullet — turning `boolean_op`'s straight-line polygon
 * output back into curves. A flattened circle is, vertex-for-vertex,
 * indistinguishable from a polygon someone drew on purpose with that many
 * sides: every turn between its ~5° segments reads as "corner," so this
 * function barely reduces it (measured: a 64-gon circle stayed at 65 path
 * commands from accuracy 0.01 all the way to 10 — 10% of its own radius —
 * and a hand-tuned wider angle threshold only got a union-of-two-circles
 * output down to the tens, not the single digits the plan's own measurement
 * goal asks for). Real reverse-curve-fitting needs least-squares Bezier
 * fitting through the point sequence (Kurbo's `fit_to_bezpath` via a custom
 * `ParamCurveFit`), not corner-preserving simplification — deferred; see
 * `vector-geometry.curves.test.ts` and vector-plan.md's Stage 8 write-up
 * for the measured numbers this leaves honestly unresolved.
 */
export function simplify_path(d: string, accuracy: number): string;

/**
 * Turns a stroked line into the filled shape it would visually paint as —
 * the "stroke to path" bullet. Once this runs, "stroke" is no longer a
 * live style property of the result; the width/cap/join/dash have all been
 * baked into geometry, same as Illustrator's own "Outline Stroke".
 */
export function stroke_to_fill(d: string, width: number, cap: string, join: string, miter_limit: number, dash: Float64Array, dash_offset: number, tolerance: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly boolean_op: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly offset_path: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly simplify_path: (a: number, b: number, c: number) => [number, number];
    readonly stroke_to_fill: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
