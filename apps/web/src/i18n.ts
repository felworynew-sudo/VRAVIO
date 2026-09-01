import type { Language } from "./store";

export function localized(label: string, language: Language): string {
  const match = label.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!match) return label;
  return language === "ru" ? match[2]! : match[1]!.trim();
}

export function text(language: Language, english: string, russian: string): string {
  return language === "ru" ? russian : english;
}
