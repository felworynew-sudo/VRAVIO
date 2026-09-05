import type { EnvironmentKind } from "@vravio/kernel";
import { resolveLabel } from "../../i18n";
import { kernel } from "../../kernel";
import { useShellStore } from "../../store";
import { tools } from "../../tools";
import { CATEGORY_TOOLS } from "../categories";
import type { CommandDefinition } from "../types";

/**
 * One command per letter a tool's shortcut sits on, not one per tool.
 *
 * Photoshop's own convention: a plain letter always selects the first tool
 * sharing it (e.g. M is the Marquee), and Shift steps to the next one in the
 * group, wrapping around. Raster and vector each get their own scope, because
 * both put a tool on some of the same letters (V is Move in raster, Selection
 * in vector) and only one document kind is active at a time.
 *
 * Generated rather than written out, and shell-level rather than filed under
 * an environment, because `tools.ts` still holds both environments' tools in
 * one catalogue. Adding a tool file still adds its shortcut command for free,
 * which is the property that matters; this file moves under an environment on
 * the day the tool catalogue itself does.
 */
function toolShortcutCommands(): readonly CommandDefinition[] {
  const groups = new Map<string, typeof tools[number][]>();
  for (const tool of tools) {
    const key = `${tool.kind}:${tool.shortcut.toLocaleUpperCase()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(tool);
  }

  return [...groups].map(([key, group]) => {
    const [kind, letter] = key.split(":") as [EnvironmentKind, string];
    return {
      id: `tool.${kind}.${letter.toLocaleLowerCase()}`,
      // Each language's own names joined separately, then wrapped once — not
      // a join of already-combined "English (Русский)" strings, which used
      // to mangle both halves whenever a shortcut letter held more than one
      // tool (e.g. R for Blur/Smudge): localized()'s regex matches only the
      // *last* parenthesised pair in the joined string, so the Russian side
      // silently dropped every name but the last and the English side ended
      // up with a stray Russian fragment baked into it.
      label: {
        en: group.map((tool) => resolveLabel(tool.label, "en")).join(" / "),
        ru: group.map((tool) => resolveLabel(tool.label, "ru")).join(" / "),
      },
      category: CATEGORY_TOOLS,
      shortcut: letter,
      scope: kind,
      // The toolbar is where a tool is picked; the menu bar has never listed
      // tools and listing twenty-three of them there would drown it.
      surfaces: ["toolbar", "palette"],
      isEnabled: ({ activeDocumentId }) => kernel.documents.get(activeDocumentId ?? "")?.kind === kind,
      execute: ({ activeDocumentId, shiftKey }) => {
        if (!activeDocumentId) return;
        const current = useShellStore.getState().activeToolByDocument[activeDocumentId];
        const currentIndex = group.findIndex((tool) => tool.id === current);
        const tool = shiftKey && group.length > 1 ? group[(currentIndex + 1 + group.length) % group.length] : group[0];
        if (tool) useShellStore.getState().setTool(activeDocumentId, tool.id);
      },
    } satisfies CommandDefinition;
  });
}

export default toolShortcutCommands();
