import type { EnvironmentKind } from "@vravio/kernel";
import { windowsFor } from "./registry";

/**
 * Which panels are on screen, per environment, across reloads.
 *
 * One implementation where there were two identical ones. The storage keys are
 * unchanged (`vravio.raster-panels.visible`, `vravio.vector-panels.visible`) —
 * both copies already followed this pattern, and changing it would silently
 * reset the panel layout of anyone who has used the application before.
 *
 * The two event pairs became one: a listener that wants to know about panels
 * no longer has to subscribe twice and remember which name belongs to which
 * environment, and a new environment gets its events by existing.
 */
const storageKey = (kind: EnvironmentKind | string): string => `vravio.${kind}-panels.visible`;

/** Fired when something asks for a panel to be shown or hidden. */
export const PANEL_REQUEST_EVENT = "vravio-panel-visibility-request";
/** Fired once the change has been stored. */
export const PANEL_CHANGED_EVENT = "vravio-panel-visibility-changed";

export interface PanelVisibilityDetail { readonly kind: string; readonly id: string; readonly visible: boolean }

function defaults(kind: EnvironmentKind | string): Set<string> {
  return new Set(windowsFor(kind).filter((definition) => definition.defaultVisible).map((definition) => definition.id));
}

export function readVisiblePanelIds(kind: EnvironmentKind | string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(kind)) ?? "null") as unknown;
    if (Array.isArray(value)) return new Set(value.filter((id): id is string => typeof id === "string"));
  } catch { /* invalid layouts fall back to defaults */ }
  return defaults(kind);
}

export function persistVisiblePanelIds(kind: EnvironmentKind | string, ids: Iterable<string>): void {
  localStorage.setItem(storageKey(kind), JSON.stringify([...ids]));
  window.dispatchEvent(new Event(PANEL_CHANGED_EVENT));
}

export function requestPanelVisibility(kind: EnvironmentKind | string, id: string, visible: boolean): void {
  const ids = readVisiblePanelIds(kind);
  if (visible) ids.add(id); else ids.delete(id);
  persistVisiblePanelIds(kind, ids);
  window.dispatchEvent(new CustomEvent<PanelVisibilityDetail>(PANEL_REQUEST_EVENT, { detail: { kind, id, visible } }));
}
