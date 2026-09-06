/* tslint:disable */
/* eslint-disable */

/**
 * Converts one CMYK colour (each channel 0..255, matching qcms's own
 * `DataType::CMYK` byte convention — a caller working in this codebase's
 * own 0..1 convention, see `kernel/color.ts`'s `Color.components` doc
 * comment, scales by 255 first) through the given ICC CMYK profile into
 * sRGB bytes `[r, g, b]`. `None` if `profile_bytes` is not a profile qcms
 * can parse, or the transform itself cannot be built (a non-CMYK profile,
 * for instance — passing an RGB profile here is a caller error, not a
 * data error, so this reports it the same way rather than guessing).
 */
export function cmyk_to_srgb(c: number, m: number, y: number, k: number, profile_bytes: Uint8Array): Uint8Array | undefined;

/**
 * Stage 14 of docs/vector-plan.md: real, ICC-based colour management —
 * not the naive `(1-c)(1-k)` formula `kernel/color.ts`'s own `colorToCss`
 * already documents as a placeholder for exactly this crate to replace,
 * where a profile actually exists to do the real math with.
 *
 * The donor is `qcms` — Mozilla's own colour management library, used in
 * Firefox to display embedded ICC profiles correctly, pure Rust, and
 * compiles to `wasm32-unknown-unknown` with zero feature-flag surgery
 * (confirmed directly: `cargo build --target wasm32-unknown-unknown` on
 * an empty crate depending on nothing else). The same "check open source
 * first" pass that found it also found its real limit, which this crate
 * is honest about rather than working around by half-measures:
 *
 * **qcms only transforms CMYK → RGB, never the other way.** Its own
 * `transform_create` hard-codes the pairs of (input type, output type) it
 * will build a transform for — `(CMYK, RGB8)` is one of them,
 * `(RGB8, CMYK)` is not; every unlisted pair falls through to `None`. This
 * isn't a missing feature to work around with a few more lines: qcms was
 * built for *display* (show a CMYK JPEG correctly on an sRGB screen), a
 * job that only ever needs that one direction. Turning an arbitrary sRGB
 * colour into press-ready CMYK ink percentages is a different, genuinely
 * harder problem (gamut mapping, black generation/under colour removal
 * policy — the same reason ICC profiles ship both an A2B *and* a B2A
 * table rather than one invertible function) that a display-only CMM has
 * no reason to solve, and no pure-Rust, wasm32-compatible library this
 * pass found does either (the industry-standard answer, Little CMS, is a
 * C library — the same "needs a C toolchain wasm32-unknown-unknown
 * doesn't have" wall Clipper2 hit in stage 7).
 *
 * So: `cmyk_to_srgb` below is real, ICC-profile-accurate colour
 * management. The reverse (`srgb_to_cmyk`, and therefore a document's own
 * CMYK *export*) is not implemented here and is recorded as an open gap
 * in docs/vector-plan.md rather than faked with the same naive formula
 * this crate exists to move past.
 */
export function validate_icc_profile(bytes: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly cmyk_to_srgb: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly validate_icc_profile: (a: number, b: number) => number;
    readonly qcms_transform_data_rgb_out_lut: (a: number, b: number, c: number, d: number) => void;
    readonly qcms_transform_data_rgba_out_lut: (a: number, b: number, c: number, d: number) => void;
    readonly qcms_transform_data_bgra_out_lut: (a: number, b: number, c: number, d: number) => void;
    readonly qcms_transform_data_rgb_out_lut_precache: (a: number, b: number, c: number, d: number) => void;
    readonly qcms_transform_data_rgba_out_lut_precache: (a: number, b: number, c: number, d: number) => void;
    readonly qcms_transform_data_bgra_out_lut_precache: (a: number, b: number, c: number, d: number) => void;
    readonly qcms_enable_iccv4: () => void;
    readonly qcms_profile_precache_output_transform: (a: number) => void;
    readonly qcms_transform_release: (a: number) => void;
    readonly qcms_profile_is_bogus: (a: number) => number;
    readonly qcms_white_point_sRGB: (a: number) => void;
    readonly lut_inverse_interp16: (a: number, b: number, c: number) => number;
    readonly lut_interp_linear16: (a: number, b: number, c: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
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
