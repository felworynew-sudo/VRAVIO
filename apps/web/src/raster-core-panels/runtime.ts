import { rasterCorePanels } from "./registry";

const STORAGE_KEY = "vravio.raster-panels.visible";
export const PANEL_REQUEST_EVENT = "vravio-panel-visibility-request";
export const PANEL_CHANGED_EVENT = "vravio-panel-visibility-changed";

function defaults(): Set<string> { return new Set(rasterCorePanels.filter((panel) => panel.defaultVisible).map((panel) => panel.id)); }
export function readVisiblePanelIds(): Set<string> {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown; if (Array.isArray(value)) return new Set(value.filter((id): id is string => typeof id === "string")); } catch { /* invalid layouts fall back to defaults */ }
  return defaults();
}
export function persistVisiblePanelIds(ids: Iterable<string>): void { localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids])); window.dispatchEvent(new Event(PANEL_CHANGED_EVENT)); }
export function requestPanelVisibility(id: string, visible: boolean): void {
  const ids = readVisiblePanelIds(); if (visible) ids.add(id); else ids.delete(id); persistVisiblePanelIds(ids);
  window.dispatchEvent(new CustomEvent(PANEL_REQUEST_EVENT, { detail: { id, visible } }));
}
