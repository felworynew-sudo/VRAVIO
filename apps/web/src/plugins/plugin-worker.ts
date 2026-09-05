import type { PluginModule, PluginRunRequest } from "./types";

/**
 * Where plugin code actually runs.
 *
 * A worker, not the main thread, and section 4.7 of docs/migration-plan.md
 * gives both halves of the reason: other people's code must not be able to
 * hang the interface, and it must not have the DOM. The second is the one that
 * matters most — a plugin on the main thread could read the document, the
 * asset store, `localStorage` and every credential the page holds, whatever
 * its manifest claimed to want. Here it has none of that: no `document`, no
 * `window`, and only the pixels the host chose to send.
 *
 * The host still checks permissions on both sides of the wire. This side
 * cannot be trusted to police itself — it is the untrusted part — so the
 * checks that matter live in `host.ts`; the worker simply never receives what
 * it was not granted.
 */
interface PluginWorkerScope {
  onmessage: ((event: MessageEvent<PluginRunRequest & { readonly entry?: string }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as PluginWorkerScope;

/** Loaded once, on the first run: a plugin that is never used costs nothing. */
let loaded: Promise<PluginModule> | null = null;
let entryUrl: string | null = null;

const load = (entry: string): Promise<PluginModule> => {
  entryUrl ??= entry;
  loaded ??= import(/* @vite-ignore */ entry) as Promise<PluginModule>;
  return loaded;
};

scope.onmessage = async (event) => {
  const request = event.data;
  if (request.type !== "run") return;

  try {
    if (!request.entry) throw new Error("No plugin entry was given");
    if (entryUrl && entryUrl !== request.entry) throw new Error("This worker is already running a different plugin");
    const plugin = await load(request.entry);
    if (typeof plugin.run !== "function") throw new Error("Plugin does not export run()");

    const pixels = request.pixels ? new Uint8ClampedArray(request.pixels) : null;
    const result = await plugin.run({ pixels, width: request.width, height: request.height, options: request.options });

    if (!result) { scope.postMessage({ type: "result", requestId: request.requestId }); return; }
    const buffer = result.buffer instanceof ArrayBuffer ? result.buffer : result.slice().buffer;
    scope.postMessage({ type: "result", requestId: request.requestId, pixels: buffer, width: request.width, height: request.height }, [buffer]);
  } catch (error) {
    // A plugin that throws is reported, not swallowed: the host turns this
    // into a message naming the plugin, which is the only way the user can
    // tell a broken plugin from a broken application.
    scope.postMessage({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
  }
};
