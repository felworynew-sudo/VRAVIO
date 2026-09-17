import { CATEGORY_LAYER, CATEGORY_SELECT } from "../../../../commands/categories";
import type { CommandDefinition } from "../../../../commands/types";
import { runSegmentQuickAction, segmentQuickActionAvailable } from "../../../../segment-quick-actions";

/**
 * Select Subject and Remove Background as commands — the Properties panel's
 * Quick Actions and the Contextual Task Bar both reach them through here
 * (see `segment-quick-actions.ts` for why the logic moved out of the panel).
 * Photoshop files Subject under Select; Remove Background edits the layer
 * (non-destructively, as a mask), so it sits with the layer commands.
 */
const commands: readonly CommandDefinition[] = [
  {
    id: "select.subject",
    label: { en: "Select Subject", ru: "Выделить объект" },
    category: CATEGORY_SELECT,
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => segmentQuickActionAvailable(activeDocumentId),
    execute: ({ activeDocumentId }) => activeDocumentId ? runSegmentQuickAction(activeDocumentId, "select") : undefined,
  },
  {
    id: "layer.removeBackground",
    label: { en: "Remove Background", ru: "Удалить фон" },
    category: CATEGORY_LAYER,
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => segmentQuickActionAvailable(activeDocumentId),
    execute: ({ activeDocumentId }) => activeDocumentId ? runSegmentQuickAction(activeDocumentId, "remove") : undefined,
  },
];

export default commands;
