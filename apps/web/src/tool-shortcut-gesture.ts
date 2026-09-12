import type { EnvironmentKind } from "@vravio/kernel";
import { tools } from "./tools";

/** A short key tap picks a tool; holding it invokes the temporary variant. */
export const TOOL_SHORTCUT_TAP_MS = 220;

/**
 * Resolves the actual tool a generated `tool.<environment>.<letter>` command
 * would select. Keymap overrides still resolve to that same command id, so
 * this also covers a user who assigns the Zoom command to another key.
 */
export function zoomToolForShortcutCommand(commandId: string | undefined, kind: EnvironmentKind | undefined, activeToolId: string | undefined, shiftKey: boolean): string | null {
  if (!commandId || (kind !== "raster" && kind !== "vector")) return null;
  const prefix = `tool.${kind}.`;
  if (!commandId.startsWith(prefix)) return null;
  const shortcut = commandId.slice(prefix.length).toLocaleUpperCase();
  const group = tools.filter((tool) => tool.kind === kind && tool.shortcut.toLocaleUpperCase() === shortcut);
  if (!group.length) return null;
  const currentIndex = group.findIndex((tool) => tool.id === activeToolId);
  const selected = shiftKey && group.length > 1 ? group[(currentIndex + 1 + group.length) % group.length] : group[0];
  return selected?.id.endsWith(".zoom") ? selected.id : null;
}

/** Whether releasing a temporarily-held Zoom shortcut should leave it selected. */
export function keepsZoomAfterShortcut(elapsedMs: number, dragged: boolean): boolean {
  return !dragged && elapsedMs <= TOOL_SHORTCUT_TAP_MS;
}
