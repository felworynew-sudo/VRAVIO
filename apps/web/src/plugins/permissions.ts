import { PLUGIN_API_VERSION, type PluginManifest, type PluginPermission } from "./types";

/**
 * Whether a manifest describes a plugin this host can load, and why not.
 *
 * Refusal is the point. A plugin is other people's code; the failure modes
 * worth designing for are the ones where it is wrong or hostile, not the ones
 * where it is fine. Every check here answers "should this run at all",
 * *before* a worker is spawned — a worker that has already started is a worker
 * that has already run the plugin's top-level code.
 */
export type PluginRefusal =
  | { readonly reason: "api-version"; readonly expected: number; readonly found: number }
  | { readonly reason: "unknown-permission"; readonly permission: string }
  | { readonly reason: "unhostable-environment"; readonly environment: string }
  | { readonly reason: "malformed"; readonly detail: string };

const KNOWN: readonly PluginPermission[] = ["read-document", "write-document", "network", "filesystem"];

/**
 * `hostableEnvironments` is the set of environments that actually have a
 * plugin surface in this build — passed in rather than imported so this stays
 * a pure check of a manifest against a stated capability, testable without the
 * module glob that discovers surfaces. Omit it and the environment is not
 * checked at all, which is what a caller asking "is this manifest itself
 * well-formed" wants.
 */
export function refusalFor(manifest: PluginManifest, hostableEnvironments?: readonly string[]): PluginRefusal | null {
  if (!manifest.id || typeof manifest.id !== "string") return { reason: "malformed", detail: "no id" };
  if (!manifest.entry || typeof manifest.entry !== "string") return { reason: "malformed", detail: "no entry" };
  // A plugin that does not say which environment it is for cannot be placed in
  // one, and guessing would put other people's code in front of a document it
  // never claimed to understand.
  if (!manifest.environment || typeof manifest.environment !== "string") return { reason: "malformed", detail: "no environment" };

  // Checked before anything else that matters: a plugin built for a different
  // protocol will misread every message it is sent, and the symptom would
  // surface far from the cause.
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    return { reason: "api-version", expected: PLUGIN_API_VERSION, found: manifest.apiVersion };
  }

  // An unknown permission is refused rather than ignored. Ignoring it would
  // load a plugin that asked for something this host does not understand —
  // which is exactly the case where "carry on regardless" is wrong.
  for (const permission of manifest.permissions ?? []) {
    if (!KNOWN.includes(permission)) return { reason: "unknown-permission", permission };
  }

  // An environment with no surface has no way to read a document into a
  // payload or write one back, so there is nothing for the plugin to do and
  // nothing that could safely be done with what it returned.
  if (hostableEnvironments && !hostableEnvironments.includes(manifest.environment)) {
    return { reason: "unhostable-environment", environment: manifest.environment };
  }
  return null;
}

export const grants = (manifest: PluginManifest, permission: PluginPermission): boolean =>
  (manifest.permissions ?? []).includes(permission);

/**
 * Reads a refusal back as something a person can act on.
 *
 * Kept beside the check rather than in the UI so that the reason a plugin was
 * turned away is written once, next to the rule that turned it away.
 */
export function refusalMessage(refusal: PluginRefusal): string {
  switch (refusal.reason) {
    case "api-version": return `built for plugin API ${refusal.found}, this build speaks ${refusal.expected}`;
    case "unknown-permission": return `asks for a permission this build does not know: "${refusal.permission}"`;
    case "unhostable-environment": return `is for the "${refusal.environment}" environment, which this build cannot host plugins in`;
    default: return `manifest is incomplete: ${refusal.detail}`;
  }
}
