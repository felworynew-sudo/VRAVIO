import type { BooleanOpKind, FlatPolygon, VectorCurvePort, VectorGeometryPort, StrokeToFillStyle } from "@vravio/kernel";

/**
 * The lazy-loaded half of Stage 7's `VectorGeometryPort` and Stage 8's
 * `VectorCurvePort` (docs/vector-plan.md) — `@vravio/kernel` only defines
 * the contracts (and, for Stage 7 only, the slow TS reference), since it
 * has no bundler of its own to fetch a `.wasm` file with; loading one is
 * squarely an `apps/web` (Vite) concern, the same reason `env-vector`'s own
 * catalogues are hand-assembled instead of `import.meta.glob`'d. Both
 * ports share the one lazily-loaded `crates/vector-geometry` module below —
 * one Rust crate, one `.wasm` fetch, regardless of which of the two gets
 * used first.
 *
 * `init()` is only called once module-level `boolean_op` is first awaited
 * (dynamic `import()` below), not at app startup — nothing pays for the
 * ~40 KB `.wasm` fetch/compile until a boolean operation actually runs.
 *
 * The generated glue's own `default()` init function does a plain
 * `fetch(new URL('vector_geometry_bg.wasm', import.meta.url))`, which is
 * exactly right in a real browser/Tauri build — Vite serves the asset over
 * http(s) there, so that branch is left alone. Under Vitest, though, this
 * module runs straight off disk and that URL is a real `file://` path,
 * which Node's `fetch` can't read — so on that path only, the same bytes are
 * read directly off disk instead and handed to `default()` explicitly.
 *
 * The two Node built-ins involved are imported through a non-literal
 * specifier and typed as `unknown` rather than `import("node:fs/promises")`
 * — this is a browser-only app with no `@types/node` anywhere in it (adding
 * it globally pulls in Node's ambient `setTimeout`/`Timeout` overrides,
 * which broke unrelated DOM code the one time this was tried), so the one
 * function that genuinely needs Node stays untyped rather than dragging
 * that dependency in for everyone else.
 */
interface NodeFsPromises { readFile(path: string): Promise<{ buffer: ArrayBufferLike; byteOffset: number; byteLength: number }> }
interface NodeUrl { fileURLToPath(url: string): string }

async function readWasmBytesForNode(): Promise<ArrayBuffer> {
  const nodeImport = (specifier: string) => import(/* @vite-ignore */ specifier) as Promise<unknown>;
  const fsPromises = (await nodeImport("node:fs/promises")) as NodeFsPromises;
  const url = (await nodeImport("node:url")) as NodeUrl;
  const resolved = import.meta.resolve("@vravio/vector-geometry/vector_geometry_bg.wasm");
  const buffer = await fsPromises.readFile(url.fileURLToPath(resolved));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function decodeMulti(flat: Float64Array): FlatPolygon[] {
  const polygons: FlatPolygon[] = [];
  let offset = 1;
  const count = flat[0] ?? 0;
  for (let i = 0; i < count; i += 1) {
    const length = flat[offset]!;
    const start = offset + 1;
    polygons.push(flat.slice(start, start + length * 2));
    offset = start + length * 2;
  }
  return polygons;
}

let modulePromise: Promise<typeof import("@vravio/vector-geometry")> | null = null;
function loadModule(): Promise<typeof import("@vravio/vector-geometry")> {
  if (!modulePromise) {
    modulePromise = import("@vravio/vector-geometry").then(async (mod) => {
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

export function createWasmGeometryPort(): VectorGeometryPort {
  return {
    name: "wasm",
    async booleanOp(kind: BooleanOpKind, subject: FlatPolygon, clip: FlatPolygon): Promise<FlatPolygon[]> {
      const mod = await loadModule();
      return decodeMulti(mod.boolean_op(kind, subject, clip));
    },
  };
}

export function createWasmCurvePort(): VectorCurvePort {
  return {
    name: "wasm",
    async offsetPath(d, amount, join, tolerance) {
      const mod = await loadModule();
      return mod.offset_path(d, amount, join, tolerance);
    },
    async strokeToFill(d, style: StrokeToFillStyle, tolerance) {
      const mod = await loadModule();
      return mod.stroke_to_fill(d, style.width, style.cap, style.join, style.miterLimit, new Float64Array(style.dash), style.dashOffset, tolerance);
    },
    async simplifyPath(d, accuracy) {
      const mod = await loadModule();
      return mod.simplify_path(d, accuracy);
    },
  };
}
