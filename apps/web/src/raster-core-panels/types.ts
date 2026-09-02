import type { Language } from "../store";

export interface RasterCorePanelDefinition {
  id: string;
  component: string;
  order: number;
  title: { en: string; ru: string };
  icon: string;
  defaultVisible: boolean;
}

export interface RasterCorePanelModule { default: RasterCorePanelDefinition }

export const corePanelTitle = (panel: RasterCorePanelDefinition, language: Language) => language === "ru" ? panel.title.ru : panel.title.en;
