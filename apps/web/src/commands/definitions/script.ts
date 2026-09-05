import { useScriptsStore } from "../../scripts/store";
import { CATEGORY_TOOLS } from "../categories";
import type { CommandDefinition } from "../types";
import type { LocalizedText } from "../../i18n";

/**
 * Recording, playing and deleting scripts.
 *
 * Every one carries `neverRecord`, and `isRecordable` refuses the whole
 * `script.` prefix besides — belt and braces on purpose, because forgetting
 * the flag on a command added later would produce a recording that arms the
 * recorder instead of doing the work.
 */
const CATEGORY_SCRIPT: LocalizedText = { en: "Scripts", ru: "Сценарии" };

/** The script a command acts on, when none is named: the most recent. */
const latestId = (): string | undefined => useScriptsStore.getState().scripts.at(-1)?.id;

const commands: readonly CommandDefinition[] = [
  {
    id: "script.record",
    label: { en: "Start Recording", ru: "Начать запись" },
    category: CATEGORY_SCRIPT,
    surfaces: ["menu", "palette"],
    neverRecord: true,
    isEnabled: () => !useScriptsStore.getState().recording,
    execute: () => useScriptsStore.getState().startRecording(),
  },
  {
    id: "script.stop",
    label: { en: "Stop Recording", ru: "Остановить запись" },
    category: CATEGORY_SCRIPT,
    surfaces: ["menu", "palette"],
    neverRecord: true,
    args: {
      // Named at the moment recording stops, which is when the user knows what
      // the script turned out to be. Empty falls back to a timestamp.
      name: { kind: "string", label: { en: "Name", ru: "Название" }, default: "" },
    },
    isEnabled: () => useScriptsStore.getState().recording,
    execute: (_context, args) => { useScriptsStore.getState().stopRecording(String(args?.name ?? "")); },
  },
  {
    id: "script.play",
    label: { en: "Play Script", ru: "Воспроизвести сценарий" },
    category: CATEGORY_SCRIPT,
    surfaces: ["menu", "palette"],
    neverRecord: true,
    args: {
      // Defaults to the most recently recorded one, so the command is useful
      // from the palette where there is nowhere to pick from.
      id: { kind: "string", label: { en: "Script", ru: "Сценарий" }, default: "" },
    },
    isEnabled: () => useScriptsStore.getState().scripts.length > 0 && !useScriptsStore.getState().recording,
    execute: async (_context, args) => {
      const id = String(args?.id ?? "") || latestId();
      if (id) await useScriptsStore.getState().play(id);
    },
  },
  {
    id: "script.delete",
    label: { en: "Delete Script", ru: "Удалить сценарий" },
    category: CATEGORY_SCRIPT,
    surfaces: ["palette"],
    neverRecord: true,
    args: {
      id: { kind: "string", label: { en: "Script", ru: "Сценарий" }, default: "" },
    },
    isEnabled: () => useScriptsStore.getState().scripts.length > 0,
    execute: (_context, args) => {
      const id = String(args?.id ?? "") || latestId();
      if (id) useScriptsStore.getState().remove(id);
    },
  },
];

export default commands;
