import { rasterFilterCatalog } from "@vravio/env-raster";
import { GenericFilterEditor } from "./FilterPanelEditor";
import { ShearEditor } from "./ShearEditor";
import type { FilterPanelDefinition, FilterPanelEditorProps } from "./types";

// Filters whose reference panel is not "a row of sliders/choices" — Shear's is a draggable curve,
// which cannot be derived from `RasterFilterParameter`'s own min/max/choices metadata the way
// every other widget in `GenericFilterEditor` can. Kept to a tiny override map rather than growing
// `GenericFilterEditor` a special case for one filter's own bespoke shape.
const CUSTOM_EDITORS: Partial<Record<string, (props: FilterPanelEditorProps) => React.ReactElement>> = {
  shear: ShearEditor,
};

// Mirrors i18n.ts's own `localized()` regex — the catalog's names are all "English (Русский)"
// pairs, and `FilterPanelDefinition.name` needs both halves at once rather than picked by language.
function splitName(name: string): { en: string; ru: string } {
  const match = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!match) return { en: name, ru: name };
  return { en: match[1]!.trim(), ru: match[2]! };
}

/**
 * One `FilterPanelDefinition` per catalog entry, generated instead of hand-written — every filter
 * already declares its own parameters precisely in `rasterFilterCatalog`, so its dialog is that
 * catalog entry's `id`/name/defaults plus `GenericFilterEditor` reading the same parameter list
 * (docs/master-plan.md §51, the panel-fidelity pass "это важно для всех" asked for across the
 * whole menu, not a hand-picked subset).
 */
const definitionsById = new Map<string, FilterPanelDefinition>(rasterFilterCatalog.map((filter) => {
  const definition: FilterPanelDefinition = {
    id: filter.id,
    name: splitName(filter.name),
    defaults: Object.fromEntries(filter.parameters.map((parameter) => [parameter.id, parameter.value])),
    Editor: CUSTOM_EDITORS[filter.id] ?? ((props) => <GenericFilterEditor parameters={filter.parameters} {...props}/>),
  };
  return [filter.id, definition];
}));

export function filterPanelDefinitionFor(id: string): FilterPanelDefinition | undefined {
  return definitionsById.get(id);
}
