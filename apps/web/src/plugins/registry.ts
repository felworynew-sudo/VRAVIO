import { manifest as invertManifest } from "./samples/invert.plugin";
import type { PluginManifest } from "./types";
import type { PluginWorkerLike } from "./host";

/**
 * The plugins this build knows about.
 *
 * A list rather than a glob, and deliberately: a plugin is other people's
 * code, and "any file in this directory runs" is exactly the property a plugin
 * system must not have. Installed plugins will arrive through the asset store
 * with a manifest the user approved; the sample is here because the repository
 * ships it as documentation (section 4.7).
 *
 * `spawn` is per entry so a plugin brings its own worker: the sample's worker
 * is built from this repository's own source, and an installed plugin's will
 * be built from the bytes the user accepted.
 */
export interface PluginEntry {
  readonly manifest: PluginManifest;
  spawn(): PluginWorkerLike;
}

const sample: PluginEntry = {
  manifest: invertManifest as unknown as PluginManifest,
  // `new Worker(new URL(...))` is how Vite is told to build the worker as its
  // own bundle; the plugin module itself is imported inside it.
  spawn: () => new Worker(new URL("./plugin-worker.ts", import.meta.url), { type: "module" }) as unknown as PluginWorkerLike,
};

export const plugins: readonly PluginEntry[] = [sample];

export const pluginById = (id: string | undefined): PluginEntry | undefined =>
  id ? plugins.find((entry) => entry.manifest.id === id) : undefined;
