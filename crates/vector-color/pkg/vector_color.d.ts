/* tslint:disable */
/* eslint-disable */

/**
 * Test-fixture-only: builds a minimal CMYK ICC profile carrying both an
 * `A2B` and a `B2A` tag (`lut8Type`, 2 grid points per axis — the
 * corners of the input hypercube are the only points actually stored,
 * everything else is the reading library's own interpolation), via
 * `moxcms`'s own `ColorProfile::encode()` rather than this crate hand-
 * writing ICC binary layout a second time.
 *
 * Why this exists at all: there is no small, unambiguously-licensed
 * real-world CMYK ICC profile this repo can commit and embed for
 * `cmyk_to_srgb`/`srgb_to_cmyk`'s own tests, and a first attempt at
 * hand-writing the ICC v2 header (correct enough for `qcms`, which barely
 * validates it) failed `moxcms`'s parse with `InvalidProfile` for reasons
 * that stayed opaque even after checking every header field `moxcms`'s
 * own source validates (profile signature, version, colour space,
 * PCS) — `moxcms` is the more particular reader of the two libraries
 * this crate wraps, so its own encoder is the reliable way to produce
 * bytes it (and, checked here, `qcms` too) will actually accept, rather
 * than trusting a second from-scratch binary-format implementation this
 * pass could not get to agree with the first.
 *
 * `a2b_corners` must be exactly 16×3 = 48 bytes (16 CMYK-hypercube
 * corners, 3 output channels each, address order matching
 * `apps/web/src/vector-color.test.ts`'s own `buildLut8Tag` bit ordering);
 * `b2a_corners` must be exactly 8×4 = 32 bytes (8 XYZ-cube corners, 4
 * output channels each). Panics on the wrong length — a test-fixture
 * helper's caller is this repo's own test file, not untrusted input.
 */
export function build_test_cmyk_profile(a2b_corners: Uint8Array, b2a_corners: Uint8Array): Uint8Array;

/**
 * Same shape as `build_test_cmyk_profile`, but the `B2A` tag omitted —
 * for the test that checks `srgb_to_cmyk` honestly returns `None` on a
 * profile that only carries the `cmyk_to_srgb` direction.
 */
export function build_test_cmyk_profile_a2b_only(a2b_corners: Uint8Array): Uint8Array;

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
 * Converts one sRGB colour `(r, g, b)` through the given ICC CMYK
 * profile's own **B2A** tag into CMYK ink percentages `[c, m, y, k]`
 * (each 0..255) — real gamut mapping and black generation from the
 * profile itself, not a re-derivation of `cmyk_to_srgb`'s A2B direction
 * and not the naive `(1-r)/(1-k)`-style formula this crate exists to
 * replace. `None` if `profile_bytes` doesn't parse as an ICC profile,
 * or the profile has no CMYK colour space / no B2A tag `moxcms` can use
 * to build this specific transform (a colour-managed *display* profile,
 * for instance, typically has only the A2B direction `cmyk_to_srgb`
 * already covers — that is a data problem to report honestly as `None`,
 * not a bug to route around).
 */
export function srgb_to_cmyk(r: number, g: number, b: number, profile_bytes: Uint8Array): Uint8Array | undefined;

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
 * job that only ever needs that one direction.
 *
 * A second open-source search (6 September 2026, after the owner asked
 * for the reverse direction explicitly rather than leaving it a
 * documented gap) found one: **`moxcms`** — BSD-3-Clause OR Apache-2.0,
 * pure Rust, `wasm32-unknown-unknown`-compatible (two dependencies,
 * `num-traits` and `pxfm`, both pure Rust, no C/FFI), and — unlike
 * qcms — a general ICC engine that reads a profile's **B2A** tag (PCS →
 * device), not only its A2B (device → PCS) tag. That B2A tag is exactly
 * where an ICC profile stores the gamut-mapping/black-generation policy
 * this direction genuinely needs (`moxcms`'s own `Lut3x4`/`transform_lut3_to_4.rs`
 * reads it as a real 3-in/4-out CLUT) — `srgb_to_cmyk` below still needs
 * a real profile with that tag present to do anything (a profile with
 * only an A2B tag, like a display profile, correctly yields `None` here,
 * the same honest failure `cmyk_to_srgb` already gives for the reverse
 * case). Little CMS remains the industry-standard answer and remains a C
 * library out of reach on this target — the same wall Clipper2 hit in
 * stage 7 — but this is no longer "no pure-Rust option exists at all".
 */
export function validate_icc_profile(bytes: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_test_cmyk_profile: (a: number, b: number, c: number, d: number) => [number, number];
    readonly build_test_cmyk_profile_a2b_only: (a: number, b: number) => [number, number];
    readonly cmyk_to_srgb: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly srgb_to_cmyk: (a: number, b: number, c: number, d: number, e: number) => [number, number];
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
