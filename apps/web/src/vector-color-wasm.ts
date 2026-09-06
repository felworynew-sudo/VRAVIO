/**
 * The lazy-loaded half of Stage 14's real colour management
 * (docs/vector-plan.md) — `crates/vector-color`, wrapping `qcms` (CMYK →
 * sRGB) and `moxcms` (sRGB → CMYK, added 6 September 2026 once an actual
 * pure-Rust donor for that direction was found — see that crate's README
 * and its module doc comment for why two different libraries cover the
 * two directions instead of one). Same lazy-load shape as the other WASM
 * crates' loaders (see `vector-geometry-wasm.ts`'s own doc comment for the
 * Node-vs-browser byte-loading split and why it exists).
 */
interface NodeFsPromises { readFile(path: string): Promise<{ buffer: ArrayBufferLike; byteOffset: number; byteLength: number }> }
interface NodeUrl { fileURLToPath(url: string): string }

async function readWasmBytesForNode(): Promise<ArrayBuffer> {
  const nodeImport = (specifier: string) => import(/* @vite-ignore */ specifier) as Promise<unknown>;
  const fsPromises = (await nodeImport("node:fs/promises")) as NodeFsPromises;
  const url = (await nodeImport("node:url")) as NodeUrl;
  const resolved = import.meta.resolve("@vravio/vector-color/vector_color_bg.wasm");
  const buffer = await fsPromises.readFile(url.fileURLToPath(resolved));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

let modulePromise: Promise<typeof import("@vravio/vector-color")> | null = null;
function loadModule(): Promise<typeof import("@vravio/vector-color")> {
  if (!modulePromise) {
    modulePromise = import("@vravio/vector-color").then(async (mod) => {
      if (typeof window === "undefined") {
        const bytes = await readWasmBytesForNode();
        await mod.default({ module_or_path: bytes });
      } else {
        await mod.default();
      }
      return mod;
    });
  }
  return modulePromise;
}

/** Whether `bytes` is an ICC profile qcms can actually parse — for the
 * asset store's own ICC import path to reject a bad file up front rather
 * than storing it and failing later at conversion time. */
export async function validateIccProfile(bytes: Uint8Array): Promise<boolean> {
  const mod = await loadModule();
  return mod.validate_icc_profile(bytes);
}

/**
 * A CMYK colour (each channel 0..1, this codebase's own convention — see
 * `@vravio/kernel`'s `Color.components` doc comment) through a real ICC
 * CMYK profile into sRGB bytes `[r, g, b]` — `null` if `profileBytes`
 * isn't a profile qcms can use as the CMYK side of this transform (not a
 * profile at all, or an RGB one).
 */
export async function cmykToSrgb(c: number, m: number, y: number, k: number, profileBytes: Uint8Array): Promise<readonly [number, number, number] | null> {
  const mod = await loadModule();
  const scale = (channel: number) => Math.round(Math.max(0, Math.min(1, channel)) * 255);
  const result = mod.cmyk_to_srgb(scale(c), scale(m), scale(y), scale(k), profileBytes);
  return result ? [result[0]!, result[1]!, result[2]!] : null;
}

/**
 * An sRGB colour `(r, g, b)`, each channel 0..255 (this codebase's own
 * `srgb` convention — see `@vravio/kernel`'s `Color.components` doc
 * comment, the mirror image of `cmykToSrgb`'s CMYK-side 0..1), through the
 * given ICC CMYK profile's own B2A tag into CMYK ink percentages
 * `[c, m, y, k]`, each 0..1 (that Color type's `cmyk` convention) —
 * `null` if `profileBytes` isn't usable as the CMYK side of this specific
 * transform (not a profile at all, not a CMYK profile, or a CMYK profile
 * that only carries an A2B tag — `cmykToSrgb`'s direction — and no B2A
 * this transform needs).
 */
export async function srgbToCmyk(r: number, g: number, b: number, profileBytes: Uint8Array): Promise<readonly [number, number, number, number] | null> {
  const mod = await loadModule();
  const clampByte = (channel: number) => Math.round(Math.max(0, Math.min(255, channel)));
  const unscale = (channel: number) => channel / 255;
  const result = mod.srgb_to_cmyk(clampByte(r), clampByte(g), clampByte(b), profileBytes);
  return result ? [unscale(result[0]!), unscale(result[1]!), unscale(result[2]!), unscale(result[3]!)] : null;
}

/**
 * Test-fixture builders only — not called by any production code path.
 * `vector-color.test.ts` needs a minimal CMYK ICC profile to exercise
 * `cmykToSrgb`/`srgbToCmyk` against, and this repo has no small,
 * unambiguously-licensed real-world one to commit. A first attempt hand-
 * wrote the ICC v2 binary layout directly in TypeScript for this purpose;
 * it satisfied `qcms` (which barely validates its input) but `moxcms`
 * rejected it outright for reasons that stayed opaque even after checking
 * every header field `moxcms`'s own source validates — see
 * `crates/vector-color/src/lib.rs`'s own doc comment on
 * `build_test_cmyk_profile` for the full story. These two functions
 * delegate the actual ICC byte-writing to `moxcms`'s own `ColorProfile::
 * encode()`, the same real encoder any legitimate profile-authoring tool
 * would use — not a second, independent reimplementation of the ICC
 * binary format that this pass already found doesn't reliably agree with
 * either reading library.
 */
export async function buildTestCmykIccProfile(a2bCorners: Uint8Array, b2aCorners: Uint8Array): Promise<Uint8Array> {
  const mod = await loadModule();
  return mod.build_test_cmyk_profile(a2bCorners, b2aCorners);
}

export async function buildTestCmykIccProfileA2bOnly(a2bCorners: Uint8Array): Promise<Uint8Array> {
  const mod = await loadModule();
  return mod.build_test_cmyk_profile_a2b_only(a2bCorners);
}
