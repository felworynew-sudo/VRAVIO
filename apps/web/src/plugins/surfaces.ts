import type { EnvironmentKind } from "@vravio/kernel";
import type { PluginSurface, PluginSurfaceModule } from "./types";

/**
 * Which environments can host plugins at all, discovered from
 * `environments/<kind>/plugins/surface.ts`.
 *
 * The environment comes from the path, not from a field inside the file: a
 * surface that lives under `environments/audio/` is the audio environment's,
 * and there is no way to write one that says otherwise. Exactly how the panel
 * and tool catalogues are laid out (`windows/registry.ts`), for the same
 * reason.
 *
 * This is the whole of "the system sees which environments exist": nothing
 * lists them, nothing switches on them. An environment that has a surface can
 * host plugins; one that does not, cannot — and asking for its plugins is a
 * legitimate question with an empty answer, not a mistake. Vector and video
 * have no surface today, so they offer no plugins at all rather than offering
 * some that are greyed out: there is physically nothing there to run.
 *
 * Unlike the plugins themselves (`registry.ts`, an explicit list, because a
 * plugin is other people's code) a surface is this repository's own first-party
 * code — the trusted half that knows how to read one environment's document
 * and write it back — so discovering it by glob is safe in the way globbing
 * plugin code would never be.
 */
const modules = import.meta.glob<PluginSurfaceModule>("../environments/*/plugins/surface.ts", { eager: true });

const byEnvironment = new Map<string, PluginSurface>();
for (const [path, module] of Object.entries(modules)) {
  const kind = /environments\/([^/]+)\/plugins\//.exec(path)?.[1];
  if (kind && module.default) byEnvironment.set(kind, module.default);
}

export function pluginSurfaceFor(kind: EnvironmentKind | string | undefined): PluginSurface | undefined {
  return kind ? byEnvironment.get(kind) : undefined;
}

/** The environments this build can host plugins in, sorted for a stable order
 * wherever it is shown or asserted on. */
export const environmentsWithPluginSurface: readonly string[] = [...byEnvironment.keys()].sort();
