import type { EnvironmentKind } from "@vravio/kernel";
import { persistVisiblePanelIds, readVisiblePanelIds } from "./windows/runtime";

export interface WorkspacePreset {
  readonly id: string;
  readonly label: { readonly en: string; readonly ru: string };
  readonly panels: readonly string[];
  readonly custom?: boolean;
}
export interface WorkspacePresetDetail { readonly kind: EnvironmentKind; readonly presetId: string; readonly panelIds: readonly string[]; readonly reset: boolean; }
export const WORKSPACE_PRESET_EVENT = "vravio-workspace-preset-request";
// v8 keeps media workspaces focused: audio/video own their useful controls
// inside their editors, rather than inheriting generic raster/vector docks.
export const WORKSPACE_LAYOUT_STORAGE_KEY = "vravio.workspace.default.v8";

/* A preset decides which panels a task needs. Dockview remains the one owner
   of their position and size — no second, competing layout format. */
const raster: readonly WorkspacePreset[] = [
  { id: "essentials", label: { en: "Essentials", ru: "Основное" }, panels: ["properties", "layers", "history", "assets", "color", "navigator"] },
  { id: "painting", label: { en: "Painting", ru: "Рисование" }, panels: ["properties", "layers", "color", "history"] },
  { id: "photography", label: { en: "Photography", ru: "Фотография" }, panels: ["properties", "layers", "effects", "history", "navigator"] },
  { id: "retouching", label: { en: "Retouching", ru: "Ретушь" }, panels: ["properties", "layers", "effects", "history", "navigator", "color"] },
];
const vector: readonly WorkspacePreset[] = [
  { id: "essentials", label: { en: "Essentials", ru: "Основное" }, panels: ["properties", "layers", "history", "color"] },
  { id: "illustration", label: { en: "Illustration", ru: "Иллюстрация" }, panels: ["properties", "layers", "palette", "symbols", "color", "artboards"] },
];
// AudioMass is a complete editor inside the audio workspace.  Giving it the old
// VRAVIO Inspector beside it duplicated controls and left a mostly empty dock,
// so audio has the same deliberately focused, panel-free shell as video.
const audio: readonly WorkspacePreset[] = [
  { id: "essentials", label: { en: "Audio Essentials", ru: "Основное аудио" }, panels: [] },
  { id: "editing", label: { en: "Audio Editing", ru: "Монтаж аудио" }, panels: [] },
];
const video: readonly WorkspacePreset[] = [
  { id: "essentials", label: { en: "Video Essentials", ru: "Основное видео" }, panels: [] },
  { id: "editing", label: { en: "Video Editing", ru: "Монтаж видео" }, panels: [] },
];

const customStorageKey = (kind: EnvironmentKind) => `vravio.${kind}.custom-workspaces`;
function customPresetsFor(kind: EnvironmentKind): readonly WorkspacePreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(customStorageKey(kind)) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is WorkspacePreset => Boolean(entry) && typeof entry === "object" && typeof (entry as WorkspacePreset).id === "string" && typeof (entry as WorkspacePreset).label?.en === "string" && Array.isArray((entry as WorkspacePreset).panels)).map((entry) => ({ ...entry, custom: true }));
  } catch { return []; }
}
function writeCustomPresets(kind: EnvironmentKind, presets: readonly WorkspacePreset[]): void { localStorage.setItem(customStorageKey(kind), JSON.stringify(presets.map(({ id, label, panels }) => ({ id, label, panels, custom: true })))); }
export function workspacePresetsFor(kind: EnvironmentKind): readonly WorkspacePreset[] { const builtIn = kind === "raster" ? raster : kind === "vector" ? vector : kind === "audio" ? audio : video; return [...builtIn, ...customPresetsFor(kind)]; }
export function selectedWorkspacePreset(kind: EnvironmentKind): string { return localStorage.getItem(`vravio.${kind}.workspace-preset`) ?? "essentials"; }
export function workspacePresetById(kind: EnvironmentKind, presetId = selectedWorkspacePreset(kind)): WorkspacePreset | undefined { return workspacePresetsFor(kind).find((entry) => entry.id === presetId); }
export function applyWorkspacePreset(kind: EnvironmentKind, presetId: string): void {
  const preset = workspacePresetById(kind, presetId); if (!preset) return;
  persistVisiblePanelIds(kind, preset.panels);
  localStorage.setItem(`vravio.${kind}.workspace-preset`, preset.id);
  window.dispatchEvent(new CustomEvent<WorkspacePresetDetail>(WORKSPACE_PRESET_EVENT, { detail: { kind, presetId: preset.id, panelIds: preset.panels, reset: false } }));
}
export function resetWorkspacePreset(kind: EnvironmentKind): void {
  const preset = workspacePresetById(kind); if (!preset) return;
  persistVisiblePanelIds(kind, preset.panels);
  window.dispatchEvent(new CustomEvent<WorkspacePresetDetail>(WORKSPACE_PRESET_EVENT, { detail: { kind, presetId: preset.id, panelIds: preset.panels, reset: true } }));
}
export function saveWorkspacePreset(kind: EnvironmentKind, name: string): WorkspacePreset | null {
  const label = name.trim(); if (!label) return null;
  const sourcePresetId = selectedWorkspacePreset(kind);
  const id = `custom-${Date.now().toString(36)}`;
  const preset: WorkspacePreset = { id, label: { en: label, ru: label }, panels: [...readVisiblePanelIds(kind)], custom: true };
  writeCustomPresets(kind, [...customPresetsFor(kind), preset]);
  // A named workspace is a snapshot of the actual dock, not just a list of
  // visible panels. The current layout is persisted continuously by
  // DockLayout, so copy its serialized groups/floats/sizes before selecting
  // the new id and triggering that workspace's remount.
  const serialized = localStorage.getItem(`${WORKSPACE_LAYOUT_STORAGE_KEY}.${kind}.${sourcePresetId}`);
  if (serialized) localStorage.setItem(`${WORKSPACE_LAYOUT_STORAGE_KEY}.${kind}.${id}`, serialized);
  applyWorkspacePreset(kind, preset.id);
  return preset;
}
export function renameWorkspacePreset(kind: EnvironmentKind, presetId: string, name: string): WorkspacePreset | null {
  const label = name.trim();
  const preset = workspacePresetById(kind, presetId);
  if (!label || !preset?.custom) return null;
  const renamed: WorkspacePreset = { ...preset, label: { en: label, ru: label }, custom: true };
  writeCustomPresets(kind, customPresetsFor(kind).map((entry) => entry.id === presetId ? renamed : entry));
  return renamed;
}
export function deleteWorkspacePreset(kind: EnvironmentKind, presetId: string): void {
  const preset = workspacePresetById(kind, presetId); if (!preset?.custom) return;
  writeCustomPresets(kind, customPresetsFor(kind).filter((entry) => entry.id !== presetId));
  localStorage.removeItem(`${WORKSPACE_LAYOUT_STORAGE_KEY}.${kind}.${presetId}`);
  if (selectedWorkspacePreset(kind) === presetId) applyWorkspacePreset(kind, "essentials");
}
