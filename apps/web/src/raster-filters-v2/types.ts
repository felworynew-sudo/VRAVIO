import type { Language } from "../store";

/** One filter's own settings editor — the same role `AdjustmentEditor.tsx`
 * plays for adjustments, and driven by the same `Record<string, number>`
 * shape `applyRasterFilter` already takes, so a panel's live preview is
 * exactly `applyRasterFilter(pixels, w, h, id, settings)`. */
export interface FilterPanelEditorProps {
  settings: Record<string, number>;
  language: Language;
  onChange(settings: Record<string, number>): void;
}

export interface FilterPanelDefinition {
  id: string;
  name: { en: string; ru: string };
  defaults: Record<string, number>;
  Editor(props: FilterPanelEditorProps): React.ReactElement;
}
