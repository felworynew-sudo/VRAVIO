import type { RasterCorePanelDefinition, RasterCorePanelModule } from "./types";

const modules = import.meta.glob<RasterCorePanelModule>("./definitions/*.ts", { eager: true });
export const rasterCorePanels: readonly RasterCorePanelDefinition[] = Object.values(modules).map((module) => module.default).sort((a, b) => a.order - b.order);
export const rasterCorePanelById = new Map(rasterCorePanels.map((panel) => [panel.id, panel]));
