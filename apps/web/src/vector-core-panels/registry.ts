import type { VectorCorePanelDefinition, VectorCorePanelModule } from "./types";

const modules = import.meta.glob<VectorCorePanelModule>("./definitions/*.ts", { eager: true });
export const vectorCorePanels: readonly VectorCorePanelDefinition[] = Object.values(modules).map((module) => module.default).sort((a, b) => a.order - b.order);
export const vectorCorePanelById = new Map(vectorCorePanels.map((panel) => [panel.id, panel]));
