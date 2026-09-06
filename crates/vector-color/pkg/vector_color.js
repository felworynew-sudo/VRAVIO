/* @ts-self-types="./vector_color.d.ts" */

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
