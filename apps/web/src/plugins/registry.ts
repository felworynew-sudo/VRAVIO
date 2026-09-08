import type { EnvironmentKind } from "@vravio/kernel";
import { manifest as invertManifest } from "./samples/invert.plugin";
import { manifest as gainManifest } from "./samples/gain.plugin";
import { pluginSurfaceFor } from "./surfaces";
import type { PluginManifest } from "./types";
import type { PluginWorkerLike } from "./host";

/**
 * The plugins this build knows about.
 *
 * A list rather than a glob, and deliberately: a plugin is other people's
 * code, and "any file in this directory runs" is exactly the property a plugin
 * system must not have. Installed plugins will arrive through the asset store
 * with a manifest the user approved; the samples are here because the
 * repository ships them as documentation (section 4.7).
 *
 * Note what is *not* here: any grouping by environment. A plugin says which
 * environment it is for in its own manifest, and `pluginsFor` answers from
 * that — one catalogue, with the environments sorting themselves out of it,
 * rather than a catalogue per environment that would have to be created,
 * imported and kept in step by hand every time an environment appears.
 *
 * `spawn` is per entry so a plugin brings its own worker: the samples' worker
 * is built from this repository's own source, and an installed plugin's will
 * be built from the bytes the user accepted.
 */
export interface PluginEntry {
  readonly manifest: PluginManifest;
  spawn(): PluginWorkerLike;
}

// `new Worker(new URL(...))` is how Vite is told to build the worker as its
// own bundle; the plugin module itself is imported inside it.
const spawnSampleWorker = (): PluginWorkerLike =>
  new Worker(new URL("./plugin-worker.ts", import.meta.url), { type: "module" }) as unknown as PluginWorkerLike;

export const plugins: readonly PluginEntry[] = [
  { manifest: invertManifest as unknown as PluginManifest, spawn: spawnSampleWorker },
  { manifest: gainManifest as unknown as PluginManifest, spawn: spawnSampleWorker },
];

export const pluginById = (id: string | undefined): PluginEntry | undefined =>
  id ? plugins.find((entry) => entry.manifest.id === id) : undefined;

/**
 * The plugins an environment can actually run.
 *
 * Two conditions, and both are structural rather than a list someone maintains:
 * the plugin says it is for this environment, and this build has a surface for
 * that environment to run it through. A plugin for an environment with no
 * surface is not offered — not shown-but-disabled, because there is nothing
 * there to enable.
 */
export function pluginsFor(kind: EnvironmentKind | string | undefined): readonly PluginEntry[] {
  if (!kind || !pluginSurfaceFor(kind)) return EMPTY;
  return plugins.filter((entry) => entry.manifest.environment === kind);
}

const EMPTY: readonly PluginEntry[] = [];
