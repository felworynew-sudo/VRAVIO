import { isRasterDocumentState, type RasterDocumentState } from "@vravio/env-raster";
import { kernel } from "../../../../kernel";
import { CATEGORY_3D } from "../../../../commands/categories";
import { isRasterActive } from "../../../../commands/shared";
import type { CommandDefinition } from "../../../../commands/types";
import { createScene3DExtrudeLayer, createScene3DTextLayer } from "../../../../scene3d-commands";

/** The two commands that take a raster layer into the 3D environment. */
const commands: readonly CommandDefinition[] = [
  {
    id: "layer.new3DText",
    label: { en: "New 3D Text Layer…", ru: "Новый объёмный текстовый слой…" },
    category: CATEGORY_3D,
    surfaces: ["menu", "palette"],
    isEnabled: isRasterActive,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) void createScene3DTextLayer(activeDocumentId); },
  },
  {
    id: "layer.new3DExtrude",
    label: { en: "New 3D Extrusion from Layer", ru: "Экструдировать слой в 3D" },
    category: CATEGORY_3D,
    surfaces: ["menu", "palette"],
    isEnabled: ({ activeDocumentId }) => {
      const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
      return Boolean(document && isRasterDocumentState(document.state) && document.state.activeLayerId);
    },
    execute: ({ activeDocumentId }) => {
      const document = kernel.documents.get<RasterDocumentState>(activeDocumentId ?? "");
      if (!activeDocumentId || !document || !isRasterDocumentState(document.state) || !document.state.activeLayerId) return;
      void createScene3DExtrudeLayer(activeDocumentId, document.state.activeLayerId);
    },
  },
];

export default commands;
