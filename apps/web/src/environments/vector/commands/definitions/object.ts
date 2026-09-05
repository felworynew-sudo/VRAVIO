import { isVectorDocumentState, type VectorDocumentState } from "@vravio/env-vector";
import { kernel } from "../../../../kernel";
import { useShellStore } from "../../../../store";
import { CATEGORY_OBJECT } from "../../../../commands/categories";
import type { CommandDefinition } from "../../../../commands/types";

/**
 * Opening an image shape's picture as a raster document of its own — the
 * vector-side counterpart to `layer.openElsewhere`: same round-trip manager,
 * same asset-reference mechanism, just a `vector-node` target instead of a
 * `raster-layer` one.
 */
async function openVectorImageElsewhere(documentId: string, branch: boolean): Promise<void> {
  const document = kernel.documents.get<VectorDocumentState>(documentId);
  if (!document || !isVectorDocumentState(document.state)) return;
  const shape = document.state.shapes.find((item) => item.id === document.state.activeShapeId);
  if (!shape || shape.kind !== "image") return;

  const session = await kernel.roundtrip.open({ parentDocId: documentId, target: { kind: "vector-node", nodeId: shape.id }, targetEnv: "raster", branch });
  useShellStore.getState().adoptDocument(session.childDocId);
}

const hasActiveImageShape = ({ activeDocumentId }: { activeDocumentId?: string | null }) => {
  const document = kernel.documents.get<VectorDocumentState>(activeDocumentId ?? "");
  if (!document || !isVectorDocumentState(document.state)) return false;
  const shape = document.state.shapes.find((item) => item.id === document.state.activeShapeId);
  return shape?.kind === "image";
};

const commands: readonly CommandDefinition[] = [
  {
    id: "image.openElsewhere",
    label: { en: "Edit Image in Raster Environment", ru: "Открыть картинку в растровой среде" },
    category: CATEGORY_OBJECT,
    surfaces: ["menu", "palette", "canvas-context"],
    isEnabled: hasActiveImageShape,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openVectorImageElsewhere(activeDocumentId, false); },
  },
  {
    id: "image.openElsewhereBranch",
    label: { en: "Edit Image as a Copy", ru: "Открыть картинку копией" },
    category: CATEGORY_OBJECT,
    surfaces: ["menu", "palette", "canvas-context"],
    isEnabled: hasActiveImageShape,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void openVectorImageElsewhere(activeDocumentId, true); },
  },
];

export default commands;
