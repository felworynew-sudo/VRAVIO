import { kernel } from "../../kernel";
import type { LocalizedText } from "../../i18n";
import { CATEGORY_AUDIO_EFFECTS, CATEGORY_EDIT, CATEGORY_FILE, CATEGORY_VIEW } from "../categories";
import type { CommandDefinition } from "../types";

/**
 * Command Palette entries for AudioMass — docs/master-plan.md §49 point 2:
 * every one of these already exists as a menu item (`App.tsx`'s File/Edit/
 * Effects/View arrays for `active?.kind === "audio"`), each calling
 * `audioMassCommand(menu, item)`, which is just
 * `window.dispatchEvent(new CustomEvent("vravio-audiomass-command", {detail:
 * {menu, item}}))` — but nothing in the palette's own catalogue knew they
 * existed, confirmed by `grep`ing this directory before this file existed.
 * Reuses that exact same event rather than inventing a second way to reach
 * AudioMass, so a future rename of one menu label doesn't only fix the menu.
 *
 * Palette-only (`surfaces: ["palette"]`), not `"menu"`: the File/Edit/
 * Effects/View menus for audio are still `App.tsx`'s own hardcoded arrays,
 * not generated from this catalogue (`docs/master-plan.md`'s own note on
 * `commandsForSurface` covering only `layer-context` today) — adding
 * `"menu"` here would not touch those arrays at all, only misdescribe what
 * this file actually reaches. No `shortcut` field either: none of these had
 * a real keyboard binding before (the menu labels that showed one, like
 * "Ctrl+Z", were decorative — AudioMass's own `keys.js` owns the physical
 * keys today, docs/master-plan.md §49 point 8), and giving them one here
 * would make `kernel.keymap` start intercepting keys like Space/Tab/0
 * globally, breaking those keys in every other environment — a separate,
 * larger decision §49 point 8 already named as unresolved, not this fix's
 * job to make unilaterally.
 */
const isAudioDocument = ({ activeDocumentId }: { activeDocumentId: string | null }): boolean =>
  kernel.documents.get(activeDocumentId ?? "")?.kind === "audio";

const dispatchToAudioMass = (menu: string, item: string) => (): void => {
  window.dispatchEvent(new CustomEvent("vravio-audiomass-command", { detail: { menu, item } }));
};

const fileCommands: readonly [string, string, string, string][] = [
  ["open", "File", "Load from Computer", "Open Audio…|Открыть аудио…"],
  ["export", "File", "Export / Download", "Export Audio…|Экспортировать аудио…"],
  ["newRecording", "File", "New Recording", "New Recording|Новая запись"],
  ["saveDraft", "File", "Save Draft Locally", "Save Audio Draft Locally|Сохранить аудиочерновик локально"],
  ["openDrafts", "File", "Open Local Drafts", "Open Local Drafts|Открыть локальные черновики"],
];
const editCommands: readonly [string, string, string, string][] = [
  ["undo", "Edit", "Undo", "Undo|Отменить"],
  ["redo", "Edit", "Redo", "Redo|Повторить"],
  ["play", "Edit", "Play", "Play|Воспроизвести"],
  ["stop", "Edit", "Stop", "Stop|Стоп"],
  ["selectAll", "Edit", "Select All", "Select All|Выделить всё"],
  ["deselectAll", "Edit", "Deselect All", "Deselect All|Снять выделение"],
];
const effectCommands: readonly [string, string, string, string][] = [
  ["gain", "Effects", "Gain", "Gain…|Усиление…"],
  ["fadeIn", "Effects", "Fade In", "Fade In|Плавное появление"],
  ["fadeOut", "Effects", "Fade Out", "Fade Out|Плавное затухание"],
  ["compressor", "Effects", "Compressor", "Compressor…|Компрессор…"],
  ["normalize", "Effects", "Normalize", "Normalize|Нормализация"],
  ["graphicEq", "Effects", "Graphic EQ", "Graphic EQ…|Графический эквалайзер…"],
  ["hardLimiter", "Effects", "Hard Limiter", "Hard Limiter…|Лимитер…"],
  ["delay", "Effects", "Delay", "Delay…|Задержка…"],
  ["reverb", "Effects", "Reverb", "Reverb…|Реверберация…"],
  ["reverse", "Effects", "Reverse", "Reverse|Реверс"],
  ["removeSilence", "Effects", "Remove Silence", "Remove Silence|Удалить тишину"],
];
const viewCommands: readonly [string, string, string, string][] = [
  ["frequencyAnalyser", "View", "Frequency Analyser", "Frequency Analyser|Анализатор частот"],
  ["spectrumAnalyser", "View", "Spectrum Analyser", "Spectrum Analyser|Спектральный анализатор"],
  ["multitrackMixer", "View", "Multitrack Mixer", "Multitrack Mixer|Микшер мультитрека"],
  ["tempoTools", "View", "Tempo Tools", "Tempo Tools|Инструменты темпа"],
  ["id3Tags", "View", "ID3 Tags", "ID3 Tags|Теги ID3"],
  ["centerToCursor", "View", "Center to Cursor", "Center to Cursor|Центрировать по курсору"],
  ["resetZoom", "View", "Reset Zoom", "Reset Zoom|Сбросить масштаб"],
];

const toCommand = (category: LocalizedText, idSuffix: string, [, menu, item, labels]: [string, string, string, string]): CommandDefinition => {
  const [en, ru] = labels.split("|");
  return {
    id: `audio.${idSuffix}`,
    label: { en: en!, ru: ru! },
    category,
    surfaces: ["palette"],
    isEnabled: isAudioDocument,
    execute: dispatchToAudioMass(menu, item),
  };
};

const commands: readonly CommandDefinition[] = [
  ...fileCommands.map((entry) => toCommand(CATEGORY_FILE, `file.${entry[0]}`, entry)),
  ...editCommands.map((entry) => toCommand(CATEGORY_EDIT, `edit.${entry[0]}`, entry)),
  ...effectCommands.map((entry) => toCommand(CATEGORY_AUDIO_EFFECTS, `effect.${entry[0]}`, entry)),
  ...viewCommands.map((entry) => toCommand(CATEGORY_VIEW, `view.${entry[0]}`, entry)),
];

export default commands;
