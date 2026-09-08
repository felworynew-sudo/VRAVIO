import { kernel } from "../../kernel";
import { useShellStore } from "../../store";
import { CATEGORY_EDIT } from "../categories";
import type { CommandDefinition } from "../types";

/**
 * Undo, redo, and the two shell entries that sit in the Edit menu beside them.
 *
 * `neverRecord` on undo and redo is the one place stage 7 populates that field
 * ahead of stage 9's script recorder: a script that recorded its own undo
 * would replay it, and replaying an undo undoes whatever the *playback* had
 * just done rather than what the recording did. Nothing reads the field yet.
 */
const commands: readonly CommandDefinition[] = [
  {
    id: "edit.undo",
    label: { en: "Undo", ru: "Отменить" },
    category: CATEGORY_EDIT,
    shortcut: "Mod+Z",
    surfaces: ["menu", "palette"],
    neverRecord: true,
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.historyByDocument.get(activeDocumentId)?.canUndo),
    execute: async ({ activeDocumentId }) => { if (activeDocumentId) await kernel.historyByDocument.get(activeDocumentId)?.undo(); },
  },
  {
    id: "edit.redo",
    label: { en: "Redo", ru: "Повторить" },
    category: CATEGORY_EDIT,
    shortcut: "Mod+Shift+Z",
    surfaces: ["menu", "palette"],
    neverRecord: true,
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.historyByDocument.get(activeDocumentId)?.canRedo),
    execute: async ({ activeDocumentId }) => { if (activeDocumentId) await kernel.historyByDocument.get(activeDocumentId)?.redo(); },
  },
  {
    id: "app.settings",
    label: { en: "Settings", ru: "Настройки" },
    category: CATEGORY_EDIT,
    surfaces: ["menu", "palette"],
    neverRecord: true,
    execute: () => useShellStore.getState().setSettingsOpen(true),
  },
  {
    id: "view.commandPalette",
    label: { en: "Search", ru: "Поиск" },
    category: CATEGORY_EDIT,
    // Was "Mod+F" — silently unusable, since every browser reserves Cmd/Ctrl+F for its own
    // find-in-page and the shell's own menu label (App.tsx's Window menu, and the palette-button
    // hint) had already drifted to advertise "Ctrl+K" instead — CLAUDE.md §4's "duplicate is two
    // futures that will diverge", just for a shortcut string instead of a UI label. "Mod+K" is
    // also a key chord Chrome/Edge reserve for the address bar, but — unlike truly OS-level ones
    // (Cmd+T/Cmd+W/Cmd+N) — that default only wins when nothing on the page calls
    // preventDefault() first; several popular web apps (Linear, GitHub, Slack) already bind their
    // own command palette to Cmd/Ctrl+K successfully for exactly that reason, and this shell's
    // own keydown handler (App.tsx) does call preventDefault() the moment `kernel.keymap.resolve`
    // finds a match — so binding this command to the string the UI already promises fixes the
    // bug instead of just relabeling around it.
    shortcut: "Mod+K",
    surfaces: ["menu", "palette"],
    neverRecord: true,
    execute: () => useShellStore.getState().setPaletteOpen(true),
  },
];

export default commands;
