import { grants, refusalFor, refusalMessage } from "./permissions";
import type { PluginManifest, PluginMessage } from "./types";

/**
 * Runs a plugin and hands back what it produced.
 *
 * The permission checks live here, on the trusted side. Doing them in the
 * worker would be asking the untrusted code whether it is allowed — so
 * `read-document` decides whether pixels are ever *sent*, and `write-pixels`
 * decides whether anything that comes back is *believed*. A plugin without
 * `read-document` does not receive a buffer it could exfiltrate; a plugin
 * without `write-pixels` can return whatever it likes and none of it reaches
 * the document.
 *
 * What comes back is a buffer, not an edit. Turning it into a `PixelEdit` and
 * putting it through `commitPixels` is the caller's job, and that is the point
 * of section 4.7's "обмен — сообщениями по той же схеме `PixelEdit`": a plugin
 * is subject to the rules engine (selection, locks, layer kind) for free,
 * because it reaches the document through the same single door every tool
 * does, and there is no plugin-shaped hole beside it.
 */
export interface PluginRunOutcome {
  readonly pixels: Uint8ClampedArray | null;
  readonly error: string | null;
}

const TIMEOUT_MS = 15_000;

export interface PluginWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: PluginMessage }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * One worker per run, terminated afterwards.
 *
 * Wasteful in the small and right in the large: a plugin that leaves a timer
 * running, holds a large buffer, or wedges itself in a loop cannot outlive the
 * run that started it. Keeping workers warm is an optimisation to make when
 * there is a plugin worth keeping warm for.
 */
export async function runPlugin(
  manifest: PluginManifest,
  input: { pixels: Uint8ClampedArray; width: number; height: number; options?: Readonly<Record<string, string | number | boolean>> },
  spawn: () => PluginWorkerLike,
): Promise<PluginRunOutcome> {
  const refusal = refusalFor(manifest);
  if (refusal) return { pixels: null, error: refusalMessage(refusal) };

  const worker = spawn();
  try {
    return await new Promise<PluginRunOutcome>((resolve) => {
      const timer = setTimeout(() => resolve({ pixels: null, error: `did not answer within ${TIMEOUT_MS / 1000}s` }), TIMEOUT_MS);
      const finish = (outcome: PluginRunOutcome) => { clearTimeout(timer); resolve(outcome); };

      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === "error") { finish({ pixels: null, error: message.message }); return; }
        if (!message.pixels) { finish({ pixels: null, error: null }); return; }
        // The returned buffer is only believed with `write-pixels`. Without it
        // the run still happened — a plugin may legitimately only read — but
        // nothing it sends back becomes an edit.
        if (!grants(manifest, "write-pixels")) { finish({ pixels: null, error: null }); return; }
        const pixels = new Uint8ClampedArray(message.pixels);
        // A buffer of the wrong size would be written into the layer as
        // garbage, or throw far from here. The plugin was told the dimensions;
        // returning something else is a plugin bug, and it is caught here
        // rather than trusted.
        if (pixels.length !== input.width * input.height * 4) {
          finish({ pixels: null, error: `returned ${pixels.length} bytes, expected ${input.width * input.height * 4}` });
          return;
        }
        finish({ pixels, error: null });
      };
      worker.onerror = (event) => finish({ pixels: null, error: event instanceof ErrorEvent ? event.message : "worker failed" });

      // Pixels are sent only with `read-document`. This is the half of the
      // permission that actually protects anything: a plugin that never
      // receives the picture cannot send it anywhere, whatever else it does.
      const send = grants(manifest, "read-document") ? input.pixels.slice().buffer : undefined;
      worker.postMessage(
        { type: "run", requestId: 1, entry: manifest.entry, width: input.width, height: input.height, options: input.options ?? {}, ...(send ? { pixels: send } : {}) },
        send ? [send] : [],
      );
    });
  } finally {
    worker.terminate();
  }
}
