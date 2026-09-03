import type { Language } from "../store";

export interface VectorCorePanelDefinition {
  id: string;
  component: string;
  order: number;
  title: { en: string; ru: string };
  icon: string;
  defaultVisible: boolean;
}

export interface VectorCorePanelModule { default: VectorCorePanelDefinition }

export const corePanelTitle = (panel: VectorCorePanelDefinition, language: Language) => language === "ru" ? panel.title.ru : panel.title.en;
