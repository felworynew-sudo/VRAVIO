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
  | { readonly reason: "malformed"; readonly detail: string };

const KNOWN: readonly PluginPermission[] = ["read-document", "write-pixels", "network", "filesystem"];

export function refusalFor(manifest: PluginManifest): PluginRefusal | null {
  if (!manifest.id || typeof manifest.id !== "string") return { reason: "malformed", detail: "no id" };
  if (!manifest.entry || typeof manifest.entry !== "string") return { reason: "malformed", detail: "no entry" };

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
    default: return `manifest is incomplete: ${refusal.detail}`;
  }
}
