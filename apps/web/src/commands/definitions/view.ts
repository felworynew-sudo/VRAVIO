import { useShellStore } from "../../store";
import { CATEGORY_VIEW } from "../categories";
import { hasActiveDocument } from "../shared";
import type { CommandDefinition } from "../types";

/** Zoom limits, matching the viewport's own clamps. */
const MAX_ZOOM = 64, MIN_ZOOM = 0.01, ZOOM_STEP = 1.25;

const zoomBy = (activeDocumentId: string, factor: number): void => {
  const current = useShellStore.getState().viewports[activeDocumentId];
  const zoom = factor > 1 ? Math.min(MAX_ZOOM, (current?.zoom ?? 1) * factor) : Math.max(MIN_ZOOM, (current?.zoom ?? 1) * factor);
  useShellStore.getState().setViewport(activeDocumentId, { mode: "custom", zoom });
};

const commands: readonly CommandDefinition[] = [
  {
    id: "view.fit",
    label: { en: "Fit on Screen", ru: "Подогнать по экрану" },
    category: CATEGORY_VIEW,
    shortcut: "Mod+0",
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { mode: "fit", panX: 0, panY: 0 }); },
  },
  {
    id: "view.actual",
    label: { en: "Actual Size 100%", ru: "Реальный размер 100%" },
    category: CATEGORY_VIEW,
    shortcut: "Mod+1",
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { mode: "actual", zoom: 1, panX: 0, panY: 0 }); },
  },
  {
    id: "view.zoomIn",
    label: { en: "Zoom In", ru: "Увеличить масштаб" },
    category: CATEGORY_VIEW,
    shortcut: "Mod++",
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) zoomBy(activeDocumentId, ZOOM_STEP); },
  },
  {
    id: "view.zoomOut",
    label: { en: "Zoom Out", ru: "Уменьшить масштаб" },
    category: CATEGORY_VIEW,
    shortcut: "Mod+-",
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) zoomBy(activeDocumentId, 1 / ZOOM_STEP); },
  },
  {
    id: "view.resetRotation",
    label: { en: "Reset View Rotation", ru: "Сбросить вращение вида" },
    category: CATEGORY_VIEW,
    surfaces: ["menu", "palette"],
    isEnabled: hasActiveDocument,
    execute: ({ activeDocumentId }) => { if (activeDocumentId) useShellStore.getState().setViewport(activeDocumentId, { rotation: 0 }); },
  },
  {
    id: "view.theme",
    label: { en: "Cycle Theme", ru: "Сменить тему" },
    category: CATEGORY_VIEW,
    surfaces: ["menu", "palette"],
    execute: () => useShellStore.getState().cycleTheme(),
  },
  {
    id: "view.toggleRulers",
    label: { en: "Rulers", ru: "Линейки" },
    category: CATEGORY_VIEW,
    shortcut: "Mod+R",
    surfaces: ["menu", "palette"],
    execute: () => useShellStore.getState().updatePreferences({ showRulers: !useShellStore.getState().preferences.showRulers }),
  },
  {
    id: "view.toggleGuides",
    label: { en: "Guides", ru: "Направляющие" },
    category: CATEGORY_VIEW,
    shortcut: "Mod+;",
    surfaces: ["menu", "palette"],
    execute: () => useShellStore.getState().updatePreferences({ showGuides: !useShellStore.getState().preferences.showGuides }),
  },
];

export default commands;
