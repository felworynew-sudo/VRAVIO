import { kernel } from "../../kernel";
import { CATEGORY_FILE } from "../categories";
import type { CommandDefinition } from "../types";

/**
 * Sending a layer opened in its own tab back to the document it came from,
 * and cutting that link.
 *
 * Filed under File rather than Layer because what they act on is the
 * *document* — the child tab as a whole — not a layer inside it.
 */
const commands: readonly CommandDefinition[] = [
  {
    id: "roundtrip.apply",
    label: { en: "Apply to Parent Document", ru: "Применить в исходный документ" },
    category: CATEGORY_FILE,
    shortcut: "Mod+Shift+Enter",
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.roundtrip.sessionOf(activeDocumentId)?.status !== undefined && kernel.documents.get(activeDocumentId)?.provenance),
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void kernel.roundtrip.apply(activeDocumentId); },
  },
  {
    id: "roundtrip.detach",
    label: { en: "Detach from Parent", ru: "Отвязать от исходного" },
    category: CATEGORY_FILE,
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => Boolean(activeDocumentId && kernel.documents.get(activeDocumentId)?.provenance),
    execute: ({ activeDocumentId }) => { if (activeDocumentId) kernel.roundtrip.detach(activeDocumentId); },
  },
];

export default commands;
