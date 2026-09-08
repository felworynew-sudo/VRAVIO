import type { EnvironmentKind } from "@vravio/kernel";
import type { LocalizedText } from "../i18n";

/**
 * What a plugin is allowed to ask for.
 *
 * A permission is a promise the host keeps, not a hint the plugin honours: the
 * worker cannot reach the document, the network or the filesystem by itself,
 * so an unpermitted request is one the host simply does not answer. Listing a
 * permission in the manifest is how a plugin says what it needs; whether it
 * gets it is the host's decision, and today the host grants exactly what was
 * declared and refuses everything else.
 *
 * `write-document`, not `write-pixels`: the permission is about whether what
 * came back is believed, and that question is the same whether the payload is
 * a layer's pixels, a clip's samples, or whatever a future environment sends.
 * Naming it after one environment's payload was the last place the plugin
 * system still assumed there was only ever going to be raster.
 */
export type PluginPermission = "read-document" | "write-document" | "network" | "filesystem";

/**
 * The manifest, from section 4.7 of docs/migration-plan.md.
 *
 * `apiVersion` is a refusal, not a crash: a plugin built against a host that
 * no longer exists is turned away with a message, rather than loaded and left
 * to fail somewhere deep in a message handler where the reason is unreadable.
 *
 * `environment` is what makes a plugin one environment's and not another's. It
 * is read — by `pluginsFor`, and by the refusal that turns away a plugin whose
 * environment this build cannot host at all.
 */
export interface PluginManifest {
  readonly id: string;
  readonly apiVersion: number;
  readonly label: LocalizedText;
  readonly environment: EnvironmentKind | string;
  readonly permissions: readonly PluginPermission[];
  /** Where the plugin's own commands live, if it has any. Unread for now —
   * a plugin contributes one command, its `run`, and a plugin that wants
   * several is what this becomes. */
  readonly commands?: string;
  /** The module the worker loads. */
  readonly entry: string;
}

/**
 * The API version this host speaks.
 *
 * Bumped when the message protocol below changes in a way an existing plugin
 * would not survive. A plugin declaring a different number is refused. Version
 * 2 is the move off the pixel-shaped protocol: a run now carries a
 * `PluginPayload` whose contents the host never looks inside.
 */
export const PLUGIN_API_VERSION = 2;

/**
 * What crosses the wire in either direction.
 *
 * The host does not know what is in here, and that is the point: `kind` is
 * named by the environment's own surface ("pixels", "samples", …), `meta`
 * carries whatever that environment needs to describe the buffer (a picture's
 * width and height, a clip's sample rate and channel count), and `buffer` is
 * the bulk data, transferred rather than copied. Narrow on purpose — the less
 * shape there is here, the less there is for a plugin to reach through, and
 * everything in it survives `postMessage` without a serializer.
 */
export interface PluginPayload {
  readonly kind: string;
  readonly buffer: ArrayBuffer | null;
  readonly meta: Readonly<Record<string, string | number | boolean>>;
}

export interface PluginRunRequest {
  readonly type: "run";
  readonly requestId: number;
  /** The module the worker imports — the host names it, the plugin does not. */
  readonly entry: string;
  /** Present only with `read-document`; otherwise the plugin gets no payload. */
  readonly payload?: PluginPayload;
  readonly options: Readonly<Record<string, string | number | boolean>>;
}

export interface PluginRunResult {
  readonly type: "result";
  readonly requestId: number;
  /** What the plugin produced, if anything. Ignored without `write-document` —
   * the host never turns an unpermitted payload into an edit. */
  readonly payload?: PluginPayload;
}

export interface PluginRunFailure {
  readonly type: "error";
  readonly requestId: number;
  readonly message: string;
}

export type PluginMessage = PluginRunResult | PluginRunFailure;

/** What a plugin module exports. Called inside the worker, never on the main
 * thread — see `host.ts` for why that is the whole point. */
export interface PluginModule {
  run(input: {
    /** `null` for a plugin without `read-document`, which must not throw. */
    readonly payload: PluginPayload | null;
    readonly options: Readonly<Record<string, string | number | boolean>>;
  }): PluginPayload | null | Promise<PluginPayload | null>;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * What an environment has to provide before any plugin can run inside it.
 *
 * Discovered by path (`environments/<kind>/plugins/surface.ts`), the same way
 * panels are: the environment a surface belongs to comes from where it lives,
 * not from a field that could disagree with it. An environment with no surface
 * has no plugins — not "plugins that are greyed out", but nothing to show,
 * because there is physically nothing there to run them.
 *
 * `door` is opaque to everything except the surface that receives it: whatever
 * a workspace needs to hand its own commit path over (raster's `commitPixels`
 * is bound to a hook and cannot be reached from module scope; audio's commit
 * is module-level and needs nothing). The generic half never looks inside it,
 * so no environment's shape leaks into the shared code again.
 */
export interface PluginSurface {
  /** Names this environment's payload, for a plugin to check it got what it
   * expected — and for `accept` to reject a payload from somewhere else. */
  readonly payloadKind: string;
  /** The part of the document a plugin operates on, or `null` when there is
   * nothing to send (no layer, no selected clip). */
  read(state: unknown, door: unknown): MaybePromise<PluginPayload | null>;
  /** Whether a returned payload is one this environment can use. Returns the
   * reason it cannot, or `null` when it can — the host cannot judge this,
   * because only the environment knows what a valid payload of its own kind
   * looks like. */
  accept(returned: PluginPayload, sent: PluginPayload): string | null;
  /** Writes an accepted payload back, through this environment's own single
   * door — the same one its tools use, so a plugin is subject to the same
   * rules for free. */
  commit(returned: PluginPayload, sent: PluginPayload, state: unknown, door: unknown): MaybePromise<void>;
}

export interface PluginSurfaceModule {
  readonly default: PluginSurface;
}
