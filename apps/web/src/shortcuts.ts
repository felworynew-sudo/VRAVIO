import { kernel } from "./kernel";

const STORAGE_KEY = "vravio.keymap.overrides";

/** Snapshot of the shortcut each command shipped with, taken once at registration time. */
const defaultShortcuts = new Map<string, string>();

export function rememberDefaultShortcut(commandId: string, shortcut: string): void {
  if (!defaultShortcuts.has(commandId)) defaultShortcuts.set(commandId, shortcut);
}

export function defaultShortcutOf(commandId: string): string | undefined {
  return defaultShortcuts.get(commandId);
}

function readOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeOverrides(overrides: Record<string, string>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch { /* Settings must never break editing. */ }
}

/** Re-applies any shortcuts the user has rebound, over the defaults `ensureCommandsRegistered` just bound. */
export function applyShortcutOverrides(): void {
  const overrides = readOverrides();
  for (const [commandId, shortcut] of Object.entries(overrides)) {
    const command = kernel.commands.get(commandId);
    if (command) kernel.keymap.bind(commandId, shortcut, command.scope);
  }
}

/**
 * Rebinds a command's shortcut and remembers the choice.
 *
 * Nothing here prevents two commands from sharing a shortcut — Photoshop itself lets a user do
 * that and simply resolves to one of them. `kernel.keymap.conflicts` is exposed so the calling
 * UI can warn about it instead, which is a friendlier place for that decision than deep inside
 * the rebind call.
 */
export function rebindCommandShortcut(commandId: string, shortcut: string): void {
  kernel.keymap.bind(commandId, shortcut, kernel.commands.get(commandId)?.scope);
  const overrides = readOverrides();
  overrides[commandId] = shortcut;
  writeOverrides(overrides);
}

export function resetCommandShortcut(commandId: string): void {
  const overrides = readOverrides();
  delete overrides[commandId];
  writeOverrides(overrides);
  const fallback = defaultShortcuts.get(commandId);
  if (fallback) kernel.keymap.bind(commandId, fallback, kernel.commands.get(commandId)?.scope);
  else kernel.keymap.unbind(commandId);
}

export function isShortcutOverridden(commandId: string): boolean {
  return commandId in readOverrides();
}
