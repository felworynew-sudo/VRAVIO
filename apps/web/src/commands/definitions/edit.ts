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
    shortcut: "Mod+F",
    surfaces: ["menu", "palette"],
    neverRecord: true,
    execute: () => useShellStore.getState().setPaletteOpen(true),
  },
];

export default commands;
