import { CATEGORY_EDIT } from "../../../../commands/categories";
import type { CommandDefinition } from "../../../../commands/types";
import { contentAwareFillAvailable, runContentAwareFill } from "../../../../content-aware-fill";

/**
 * Edit ▸ Content-Aware Fill — the selection filled from its surroundings by the
 * inpainting model the Remove tool and the crop tool's border fill already use
 * (see `content-aware-fill.ts`). Photoshop's Contextual Task Bar offers the
 * same operation on a selection as "Remove"; the prompt-driven Generative Fill
 * beside it has no backend here and is not offered.
 */
const commands: readonly CommandDefinition[] = [
  {
    id: "edit.contentAwareFill",
    label: { en: "Content-Aware Fill", ru: "Заливка с учётом содержимого" },
    category: CATEGORY_EDIT,
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => contentAwareFillAvailable(activeDocumentId),
    execute: ({ activeDocumentId }) => activeDocumentId ? runContentAwareFill(activeDocumentId) : undefined,
  },
];

export default commands;
