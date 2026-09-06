/**
 * The lazy-loaded half of Stage 10's SVG import and cross-check
 * (docs/vector-plan.md) — `crates/vector-svg`, a second WASM crate
 * alongside Stage 7/8's `vector-geometry` (kept separate since it pulls in
 * `usvg`/`resvg`/font-shaping crates that would otherwise bloat every
 * boolean-op or offset call with a `.wasm` nobody asked for). Same lazy-
 * load shape as `vector-geometry-wasm.ts`: nothing is fetched until the
 * first import or cross-check render actually runs, and the same Node-vs-
 * browser byte-loading split applies for the same reason (Node's `fetch`
 * can't read the `file://` URL Vitest resolves `import.meta.url` to).
 */
interface NodeFsPromises { readFile(path: string): Promise<{ buffer: ArrayBufferLike; byteOffset: number; byteLength: number }> }
interface NodeUrl { fileURLToPath(url: string): string }

async function readWasmBytesForNode(): Promise<ArrayBuffer> {
  const nodeImport = (specifier: string) => import(/* @vite-ignore */ specifier) as Promise<unknown>;
  const fsPromises = (await nodeImport("node:fs/promises")) as NodeFsPromises;
  const url = (await nodeImport("node:url")) as NodeUrl;
  const resolved = import.meta.resolve("@vravio/vector-svg/vector_svg_bg.wasm");
  const buffer = await fsPromises.readFile(url.fileURLToPath(resolved));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

let modulePromise: Promise<typeof import("@vravio/vector-svg")> | null = null;
function loadModule(): Promise<typeof import("@vravio/vector-svg")> {
  if (!modulePromise) {
    modulePromise = import("@vravio/vector-svg").then(async (mod) => {
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

/** Parses an SVG string via `usvg` and returns the flattened-shape JSON
 * `@vravio/env-vector`'s `importedShapesFromJson` turns into `VectorShape`s. */
export async function importSvgToJson(svgText: string): Promise<string> {
  const mod = await loadModule();
  return mod.import_svg(svgText);
}

/** Rasterizes an SVG string through `resvg` — an independent renderer from
 * this app's own live SVG/canvas rendering — into raw RGBA pixels. */
export async function renderSvgToRgba(svgText: string, width: number, height: number): Promise<Uint8Array> {
  const mod = await loadModule();
  return mod.render_svg_to_rgba(svgText, width, height);
}
