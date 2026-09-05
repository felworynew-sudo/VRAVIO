import type { EnvironmentKind } from "@vravio/kernel";
import type { LocalizedText } from "../../i18n";
import { kernel } from "../../kernel";
import { useShellStore } from "../../store";
import { CATEGORY_FILE } from "../categories";
import { dispatch, hasActiveDocument } from "../shared";
import type { CommandDefinition } from "../types";

/** New-document commands, one per environment; only raster carries the shortcut. */
const newDocument = (kind: EnvironmentKind, label: LocalizedText, shortcut?: string): CommandDefinition => ({
  id: `file.new.${kind}`,
  label,
  category: CATEGORY_FILE,
  ...(shortcut ? { shortcut } : {}),
  surfaces: ["menu", "palette"],
  // Raster and vector ask the new-document dialog for a size first; audio and
  // video have nothing to ask about yet and open straight away.
  execute: () => (kind === "raster" || kind === "vector" ? useShellStore.getState().requestNewDocument(kind) : useShellStore.getState().openDocument(kind)),
});

const commands: readonly CommandDefinition[] = [
  newDocument("raster", { en: "New Raster Document", ru: "Новый растровый документ" }, "Mod+N"),
  newDocument("vector", { en: "New Vector Document", ru: "Новый векторный документ" }),
  newDocument("audio", { en: "New Audio Document", ru: "Новый аудиодокумент" }),
  newDocument("video", { en: "New Video Document", ru: "Новый видеодокумент" }),
  {
    id: "file.open",
    label: { en: "Open…", ru: "Открыть…" },
    category: CATEGORY_FILE,
    shortcut: "Mod+O",
    surfaces: ["menu", "palette"],
    execute: () => dispatch("vravio-file-open"),
  },
  {
    id: "file.save",
    label: { en: "Save", ru: "Сохранить" },
    category: CATEGORY_FILE,
    shortcut: "Mod+S",
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: () => dispatch("vravio-file-save"),
  },
  {
    id: "file.saveAs",
    label: { en: "Save As…", ru: "Сохранить как…" },
    category: CATEGORY_FILE,
    shortcut: "Mod+Shift+S",
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: () => dispatch("vravio-file-save-as"),
  },
  {
    id: "file.saveCopy",
    label: { en: "Save a Copy…", ru: "Сохранить копию…" },
    category: CATEGORY_FILE,
    shortcut: "Mod+Alt+S",
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: () => dispatch("vravio-file-save-copy"),
  },
  {
    id: "file.export",
    label: { en: "Export…", ru: "Экспортировать…" },
    category: CATEGORY_FILE,
    shortcut: "Mod+Shift+Alt+W",
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === "raster",
    execute: () => dispatch("vravio-file-export"),
  },
  {
    id: "file.close",
    label: { en: "Close Document", ru: "Закрыть документ" },
    category: CATEGORY_FILE,
    shortcut: "Mod+W",
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().closeDocument(activeDocumentId); },
  },
];

export default commands;
