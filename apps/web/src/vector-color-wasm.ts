/**
 * The lazy-loaded half of Stage 14's real colour management
 * (docs/vector-plan.md) — `crates/vector-color`, wrapping `qcms`. Same
 * lazy-load shape as the other WASM crates' loaders (see
 * `vector-geometry-wasm.ts`'s own doc comment for the Node-vs-browser
 * byte-loading split and why it exists); see `crates/vector-color`'s own
 * README for what this crate does and, importantly, does not do (there is
 * no `srgbToCmyk` here — see that file for why).
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
