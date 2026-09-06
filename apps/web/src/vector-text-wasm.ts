/**
 * The lazy-loaded half of Stage 11's real text shaping
 * (docs/vector-plan.md) — `crates/vector-text`, a third WASM crate
 * alongside `vector-geometry` (Stage 7/8) and `vector-svg` (Stage 10),
 * kept separate for the same reason those two are separate from each
 * other: this one embeds ~3.4 MB of font data nothing else needs to pay
 * for. Same lazy-load shape as the other two crates' loaders (see
 * `vector-geometry-wasm.ts`'s own doc comment for the Node-vs-browser byte-
 * loading split and why it exists).
 */
interface NodeFsPromises { readFile(path: string): Promise<{ buffer: ArrayBufferLike; byteOffset: number; byteLength: number }> }
interface NodeUrl { fileURLToPath(url: string): string }

async function readWasmBytesForNode(): Promise<ArrayBuffer> {
  const nodeImport = (specifier: string) => import(/* @vite-ignore */ specifier) as Promise<unknown>;
  const fsPromises = (await nodeImport("node:fs/promises")) as NodeFsPromises;
  const url = (await nodeImport("node:url")) as NodeUrl;
  const resolved = import.meta.resolve("@vravio/vector-text/vector_text_bg.wasm");
  const buffer = await fsPromises.readFile(url.fileURLToPath(resolved));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

let modulePromise: Promise<typeof import("@vravio/vector-text")> | null = null;
function loadModule(): Promise<typeof import("@vravio/vector-text")> {
  if (!modulePromise) {
    modulePromise = import("@vravio/vector-text").then(async (mod) => {
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

export type TextScript = "latin" | "arabic" | "devanagari";

export interface ShapedGlyph {
  readonly x: number;
  readonly y: number;
  readonly advance: number;
}

export interface ShapedLine {
  readonly textStart: number;
  readonly textEnd: number;
  readonly width: number;
  readonly glyphs: readonly ShapedGlyph[];
}

export interface ShapedText {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly ShapedLine[];
}

interface RawLayoutResult {
  width: number;
  height: number;
  lines: { text_start: number; text_end: number; width: number; glyphs: { x: number; y: number; advance: number }[] }[];
}

/** Real layout via Parley/HarfRust — line breaking (when `maxWidth > 0`),
 * bidi paragraph resolution, and per-glyph shaped positions, for whichever
 * of the three embedded Noto Sans scripts `script` names. */
export async function layoutText(text: string, fontSize: number, maxWidth: number, script: TextScript = "latin"): Promise<ShapedText> {
  const mod = await loadModule();
  const raw = JSON.parse(mod.layout_text(text, fontSize, maxWidth, script)) as RawLayoutResult;
  return {
    width: raw.width,
    height: raw.height,
    lines: raw.lines.map((line) => ({
      textStart: line.text_start, textEnd: line.text_end, width: line.width,
      glyphs: line.glyphs.map((glyph) => ({ x: glyph.x, y: glyph.y, advance: glyph.advance })),
    })),
  };
}
