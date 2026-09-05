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
 */
export type PluginPermission = "read-document" | "write-pixels" | "network" | "filesystem";

/**
 * The manifest, from section 4.7 of docs/migration-plan.md.
 *
 * `apiVersion` is a refusal, not a crash: a plugin built against a host that
 * no longer exists is turned away with a message, rather than loaded and left
 * to fail somewhere deep in a message handler where the reason is unreadable.
 */
export interface PluginManifest {
  readonly id: string;
  readonly apiVersion: number;
  readonly label: LocalizedText;
  readonly environment: string;
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
 * would not survive. A plugin declaring a different number is refused.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * What the host sends a plugin, and what it may send back.
 *
 * Pixels travel as a plain buffer with its dimensions rather than as anything
 * richer, because everything here has to survive `postMessage` — and because
 * the narrower the surface, the less there is for a plugin to reach through.
 */
export interface PluginRunRequest {
  readonly type: "run";
  readonly requestId: number;
  /** Present only with `read-document`; otherwise the plugin gets no pixels. */
  readonly pixels?: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly options: Readonly<Record<string, string | number | boolean>>;
}

export interface PluginRunResult {
  readonly type: "result";
  readonly requestId: number;
  /** The pixels the plugin produced, if it produced any. Ignored without
   * `write-pixels` — the host never turns an unpermitted buffer into an edit. */
  readonly pixels?: ArrayBuffer;
  readonly width?: number;
  readonly height?: number;
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
    readonly pixels: Uint8ClampedArray | null;
    readonly width: number;
    readonly height: number;
    readonly options: Readonly<Record<string, string | number | boolean>>;
  }): Uint8ClampedArray | null | Promise<Uint8ClampedArray | null>;
}
