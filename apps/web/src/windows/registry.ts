import type { EnvironmentKind } from "@vravio/kernel";
import type { WindowDefinition, WindowModule } from "./types";

/**
 * Every environment's panels, discovered from `environments/<kind>/windows/`.
 *
 * The environment comes from the path, not from a field inside the file: a
 * panel that lives under `environments/vector/` is a vector panel, and there
 * is no way to write one that says otherwise. That is the same reason the tool
 * and rule catalogues are laid out this way.
 */
const modules = import.meta.glob<WindowModule>("../environments/*/windows/definitions/*.ts", { eager: true });

const byEnvironment = new Map<string, WindowDefinition[]>();
for (const [path, module] of Object.entries(modules)) {
  const kind = /environments\/([^/]+)\/windows\//.exec(path)?.[1];
  if (!kind) continue;
  (byEnvironment.get(kind) ?? byEnvironment.set(kind, []).get(kind)!).push(module.default);
}
for (const definitions of byEnvironment.values()) definitions.sort((a, b) => a.order - b.order);

/** The panels this environment offers, in the order they appear in the list. */
export function windowsFor(kind: EnvironmentKind | string): readonly WindowDefinition[] {
  return byEnvironment.get(kind) ?? EMPTY;
}

export function windowById(kind: EnvironmentKind | string, id: string): WindowDefinition | undefined {
  return windowsFor(kind).find((definition) => definition.id === id);
}

/** Which environments have a panel catalogue at all — audio and video do not
 * yet, and asking for theirs is a legitimate question with an empty answer,
 * not a mistake. */
export const environmentsWithWindows: readonly string[] = [...byEnvironment.keys()].sort();

const EMPTY: readonly WindowDefinition[] = [];
