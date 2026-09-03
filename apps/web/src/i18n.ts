import type { Language } from "./store";

export function localized(label: string, language: Language): string {
  const match = label.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!match) return label;
  return language === "ru" ? match[2]! : match[1]!.trim();
}

export function text(language: Language, english: string, russian: string): string {
  return language === "ru" ? russian : english;
}

/**
 * Structured text for a catalogue definition (tool, tool option, command,
 * environment) — English required, every other reserved language optional.
 *
 * This replaces baking both languages into one literal like
 * `"Brush Tool (Кисть)"` and having `localized()` regex-parse it back apart.
 * That shape could not represent "not translated yet" for a language other
 * than the two it was built for, and a `.join(" / ")` of several such
 * strings (see commands.ts's per-shortcut-letter tool switch) silently
 * mismatched language boundaries because the regex has no way to know where
 * one bilingual pair ends and the next begins.
 *
 * Optional fields fall back to English, matching this project's own
 * committed design for the reserved seven-language selector (see
 * docs/requirements.md, SHELL-007: "untranslated strings use explicit EN
 * fallback") rather than requiring every definition to carry a real
 * translation for every reserved language before it can be added.
 */
export interface LocalizedText {
  readonly en: string;
  readonly ru?: string;
  readonly uk?: string;
  readonly es?: string;
  readonly de?: string;
  readonly ja?: string;
  readonly zh?: string;
}

/** Picks the string for `language`, falling back to English. */
export function resolveLabel(label: LocalizedText, language: Language): string {
  return label[language] ?? label.en;
}

/**
 * Builds the "English (Русский)" shape `localized()` parses, from structured
 * data instead of a hand-typed literal.
 *
 * Kernel-registered commands still need this shape: `CommandRegistry.search()`
 * matches raw text against whatever is in `Command.label`/`.category`, and
 * commands register once at startup rather than being read fresh on every
 * render the way a `ToolDefinition` is — so there is nowhere to resolve the
 * *current* language from at search time without changing the kernel's
 * command contract, which is out of scope here and belongs with the command
 * catalogue's own restructuring later (docs/migration-plan.md, stage 7).
 * Baking both languages into one string, the way the hand-typed literals
 * already did, is what lets a user find a command by typing either language
 * and what keeps the palette showing the right text after a live language
 * switch, without re-registering every command when the language changes.
 */
export function legacyBilingualLabel(label: LocalizedText): string {
  return label.ru ? `${label.en} (${label.ru})` : label.en;
}
