import { rasterFilterCatalog } from "@vravio/env-raster";
import { GenericFilterEditor } from "./FilterPanelEditor";
import type { FilterPanelDefinition } from "./types";

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
    Editor: (props) => <GenericFilterEditor parameters={filter.parameters} {...props}/>,
  };
  return [filter.id, definition];
}));

export function filterPanelDefinitionFor(id: string): FilterPanelDefinition | undefined {
  return definitionsById.get(id);
}
