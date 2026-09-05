import type { EnvironmentKind } from "@vravio/kernel";
import { rasterToolGroups, toolsFor } from "../tools";

/**
 * How the tool palette is arranged, for one environment.
 *
 * Groups in the order they appear down the palette; each group an ordered list
 * of tool ids sharing one slot, the first being the one whose glyph shows.
 * `hidden` is the tools deliberately left out — Photoshop's "Extra tools", the
 * ones you have but do not want in the way.
 *
 * Stage 8 of docs/migration-plan.md, and the first change in the whole
 * migration that a user is meant to notice.
 */
export interface ToolbarLayout {
  readonly groups: readonly (readonly string[])[];
  readonly hidden: readonly string[];
}

/**
 * The stored arrangement, and the version that lets a changed default reach
 * everyone.
 *
 * A stored layout deliberately survives changes to the catalogue —
 * `reconcileLayout` adds and removes tools without disturbing what the user
 * arranged. That is right for a tool appearing or vanishing, and wrong for a
 * change to the *grouping* that everyone is meant to get: those users would
 * keep the old arrangement forever and never know a better one existed.
 *
 * Raising this number is how such a change is delivered. It discards
 * customisation once, for everyone, which is a real cost and the reason it is
 * a deliberate act rather than something that happens whenever the defaults
 * move. Only raise it when the new default is one existing users should have.
 *
 * v2: healing, patch, stamp and the removal brush became one retouching slot.
 */
const storageKey = (kind: EnvironmentKind | string): string => `vravio.${kind}-toolbar.v2`;

export const TOOLBAR_CHANGED_EVENT = "vravio-toolbar-layout-changed";

/**
 * The arrangement the application ships with.
 *
 * Raster's grouping is Photoshop's, and is data in `tools.ts` rather than
 * something this module decides. Vector has no groups yet, so every tool gets
 * a slot of its own — which is what the palette already did for it.
 */
export function defaultLayout(kind: EnvironmentKind | string): ToolbarLayout {
  if (kind === "raster") return { groups: rasterToolGroups.map((group) => [...group]), hidden: [] };
  return { groups: toolsFor(kind as EnvironmentKind).map((tool) => [tool.id]), hidden: [] };
}

/**
 * Brings a stored layout back into agreement with the tool catalogue.
 *
 * A layout is written once and read for as long as the installation lives,
 * while the catalogue keeps changing underneath it. Without this, a tool added
 * after the user last rearranged their palette would never appear — it is in
 * no group, so nothing draws it — and a tool since removed would leave a slot
 * that renders nothing or, worse, throws. Neither failure announces itself.
 *
 * A tool the catalogue has and the layout does not is appended in its own
 * group, at the end: visible, and not silently reordering what the user
 * arranged. A tool the layout has and the catalogue does not is dropped.
 */
export function reconcileLayout(layout: ToolbarLayout, kind: EnvironmentKind | string): ToolbarLayout {
  const known = new Set(toolsFor(kind as EnvironmentKind).map((tool) => tool.id));

  const seen = new Set<string>();
  const keep = (id: string): boolean => {
    // Also drops a duplicate: an id in two groups would render twice and the
    // second copy could never be selected away from the first.
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  };

  const groups = layout.groups.map((group) => group.filter(keep)).filter((group) => group.length > 0);
  const hidden = layout.hidden.filter(keep);
  const missing = [...known].filter((id) => !seen.has(id));

  return { groups: [...groups, ...missing.map((id) => [id])], hidden };
}

export function readToolbarLayout(kind: EnvironmentKind | string): ToolbarLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(kind)) ?? "null") as unknown;
    if (raw && typeof raw === "object" && Array.isArray((raw as ToolbarLayout).groups)) {
      const stored = raw as ToolbarLayout;
      return reconcileLayout({
        groups: stored.groups.filter(Array.isArray).map((group) => group.filter((id): id is string => typeof id === "string")),
        hidden: Array.isArray(stored.hidden) ? stored.hidden.filter((id): id is string => typeof id === "string") : [],
      }, kind);
    }
  } catch { /* a layout that will not parse is one the user is better off without */ }
  return defaultLayout(kind);
}

/** Two arrangements are the same when they hold the same tools in the same
 * slots in the same order. */
export function sameLayout(left: ToolbarLayout, right: ToolbarLayout): boolean {
  return JSON.stringify(left.groups) === JSON.stringify(right.groups) && JSON.stringify([...left.hidden]) === JSON.stringify([...right.hidden]);
}

export function persistToolbarLayout(kind: EnvironmentKind | string, layout: ToolbarLayout): void {
  // Storing an arrangement identical to the default would mark the palette as
  // "arranged by the user" when it is not — and "Reset to default" would then
  // offer to undo nothing. Absence of a stored layout is what "default" means,
  // so saving the default is deleting.
  if (sameLayout(layout, defaultLayout(kind))) { resetToolbarLayout(kind); return; }
  localStorage.setItem(storageKey(kind), JSON.stringify(layout));
  window.dispatchEvent(new Event(TOOLBAR_CHANGED_EVENT));
}

/** Forgets the arrangement entirely, so `defaultLayout` answers again. */
export function resetToolbarLayout(kind: EnvironmentKind | string): void {
  localStorage.removeItem(storageKey(kind));
  window.dispatchEvent(new Event(TOOLBAR_CHANGED_EVENT));
}

/** True when the user has arranged this palette themselves — what tells the
 * editor whether "reset" has anything to undo. */
export function hasCustomToolbarLayout(kind: EnvironmentKind | string): boolean {
  return localStorage.getItem(storageKey(kind)) !== null;
}
