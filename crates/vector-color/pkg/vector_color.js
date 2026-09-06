/* @ts-self-types="./vector_color.d.ts" */

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
 * @param {Uint8Array} a2b_corners
 * @param {Uint8Array} b2a_corners
 * @returns {Uint8Array}
 */
export function build_test_cmyk_profile(a2b_corners, b2a_corners) {
    const ptr0 = passArray8ToWasm0(a2b_corners, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(b2a_corners, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.build_test_cmyk_profile(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Same shape as `build_test_cmyk_profile`, but the `B2A` tag omitted —
 * for the test that checks `srgb_to_cmyk` honestly returns `None` on a
 * profile that only carries the `cmyk_to_srgb` direction.
 * @param {Uint8Array} a2b_corners
 * @returns {Uint8Array}
 */
export function build_test_cmyk_profile_a2b_only(a2b_corners) {
    const ptr0 = passArray8ToWasm0(a2b_corners, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.build_test_cmyk_profile_a2b_only(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Converts one CMYK colour (each channel 0..255, matching qcms's own
 * `DataType::CMYK` byte convention — a caller working in this codebase's
 * own 0..1 convention, see `kernel/color.ts`'s `Color.components` doc
 * comment, scales by 255 first) through the given ICC CMYK profile into
 * sRGB bytes `[r, g, b]`. `None` if `profile_bytes` is not a profile qcms
 * can parse, or the transform itself cannot be built (a non-CMYK profile,
 * for instance — passing an RGB profile here is a caller error, not a
 * data error, so this reports it the same way rather than guessing).
 * @param {number} c
 * @param {number} m
 * @param {number} y
 * @param {number} k
 * @param {Uint8Array} profile_bytes
 * @returns {Uint8Array | undefined}
 */
export function cmyk_to_srgb(c, m, y, k, profile_bytes) {
    const ptr0 = passArray8ToWasm0(profile_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.cmyk_to_srgb(c, m, y, k, ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v2;
}

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
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {Uint8Array} profile_bytes
 * @returns {Uint8Array | undefined}
 */
export function srgb_to_cmyk(r, g, b, profile_bytes) {
    const ptr0 = passArray8ToWasm0(profile_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.srgb_to_cmyk(r, g, b, ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v2;
}

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
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function validate_icc_profile(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validate_icc_profile(ptr0, len0);
    return ret !== 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./vector_color_bg.js": import0,
    };
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('vector_color_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
