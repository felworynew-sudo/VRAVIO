import { grants, refusalFor, refusalMessage } from "./permissions";
import type { PluginManifest, PluginMessage, PluginPayload } from "./types";

/**
 * Runs a plugin and hands back what it produced.
 *
 * The permission checks live here, on the trusted side. Doing them in the
 * worker would be asking the untrusted code whether it is allowed — so
 * `read-document` decides whether the payload is ever *sent*, and
 * `write-document` decides whether anything that comes back is *believed*. A
 * plugin without `read-document` does not receive a payload it could
 * exfiltrate; a plugin without `write-document` can return whatever it likes
 * and none of it reaches the document.
 *
 * What comes back is a payload, not an edit — and this file never looks inside
 * it. Judging whether a returned payload is usable belongs to the environment
 * that knows what its own payload means (`PluginSurface.accept`), and turning
 * it into an edit belongs to that environment's single door
 * (`PluginSurface.commit`). That is what keeps section 4.7's "обмен —
 * сообщениями по той же схеме `PixelEdit`" true for every environment at once:
 * a plugin reaches a document through the same door its tools do, and there is
 * no plugin-shaped hole beside it — in any environment, because this half has
 * no idea which one it is serving.
 */
export interface PluginRunOutcome {
  readonly payload: PluginPayload | null;
  readonly error: string | null;
}

const TIMEOUT_MS = 15_000;

export interface PluginWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: PluginMessage }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RunPluginOptions {
  /** What the plugin operates on — sent only with `read-document`. */
  readonly payload: PluginPayload;
  readonly options?: Readonly<Record<string, string | number | boolean>>;
  /** Environments this build can host plugins in; a manifest naming another is
   * refused before a worker exists. */
  readonly hostableEnvironments?: readonly string[];
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
  input: RunPluginOptions,
  spawn: () => PluginWorkerLike,
): Promise<PluginRunOutcome> {
  const refusal = refusalFor(manifest, input.hostableEnvironments);
  if (refusal) return { payload: null, error: refusalMessage(refusal) };

  const worker = spawn();
  try {
    return await new Promise<PluginRunOutcome>((resolve) => {
      const timer = setTimeout(() => resolve({ payload: null, error: `did not answer within ${TIMEOUT_MS / 1000}s` }), TIMEOUT_MS);
      const finish = (outcome: PluginRunOutcome) => { clearTimeout(timer); resolve(outcome); };

      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === "error") { finish({ payload: null, error: message.message }); return; }
        if (!message.payload) { finish({ payload: null, error: null }); return; }
        // The returned payload is only believed with `write-document`. Without
        // it the run still happened — a plugin may legitimately only read — but
        // nothing it sends back becomes an edit.
        if (!grants(manifest, "write-document")) { finish({ payload: null, error: null }); return; }
        finish({ payload: message.payload, error: null });
      };
      worker.onerror = (event) => finish({ payload: null, error: event instanceof ErrorEvent ? event.message : "worker failed" });

      // The payload is sent only with `read-document`. This is the half of the
      // permission that actually protects anything: a plugin that never
      // receives the document cannot send it anywhere, whatever else it does.
      const permitted = grants(manifest, "read-document");
      const buffer = permitted && input.payload.buffer ? input.payload.buffer.slice(0) : null;
      const payload = permitted ? { kind: input.payload.kind, meta: input.payload.meta, buffer } : undefined;
      worker.postMessage(
        { type: "run", requestId: 1, entry: manifest.entry, options: input.options ?? {}, ...(payload ? { payload } : {}) },
        buffer ? [buffer] : [],
      );
    });
  } finally {
    worker.terminate();
  }
}
