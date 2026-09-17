import { isRasterDocumentState, type RasterDocumentState } from "@vravio/env-raster";
import { isVectorDocumentState } from "@vravio/env-vector";
import type { CommandContext } from "@vravio/kernel";
import { commandDefinitionById } from "../commands/registry";
import type { LocalizedText } from "../i18n";
import { kernel } from "../kernel";
import { applyPathfinderOp, groupActiveVectorShapes, ungroupActiveVectorGroup } from "../vector-commands";

/**
 * The Contextual Task Bar's states, as data (docs/master-plan.md §11.3).
 *
 * Photoshop's own bar is the donor for *what* shows when (closed source, so
 * user-facing behaviour): a pixel layer with nothing selected offers Select
 * Subject / Remove Background; an active selection offers Modify (Feather),
 * Invert, Create Mask, Fill and Deselect; a selected mask offers Invert; and
 * so on. Which of those VRAVIO can actually back is what decides the table:
 * every entry names a command that already exists in the catalogue, so the
 * bar is one more door onto the single implementation, never a second one
 * (CLAUDE.md §4) — and a Photoshop action with nothing behind it (Generative
 * Fill, Transform Selection, type controls…) is simply not listed (§3).
 *
 * A new state is a new row here, not a new `if` in the component (§6). Rows
 * are tried in order; the first whose `when` holds *and* which still has an
 * enabled action wins. The second condition matters: "active selection" on a
 * layer that already has a mask loses Create Mask but keeps the rest, while a
 * state whose every action is disabled falls through rather than showing an
 * empty bar — a bar of greyed-out buttons says nothing useful.
 */

export interface ContextualBarContext {
  readonly documentId: string;
  readonly state: unknown;
  /** The layer whose mask is the paint target, from the Layers panel. */
  readonly editingMaskLayerId: string | null;
  /** The Layers panel's multi-selection. */
  readonly selectedLayerIds: readonly string[];
}

/**
 * One button. A catalogue command wherever one exists — label and enabled
 * state then come from the catalogue, so the bar cannot drift from the menu.
 * `run` is only for operations that exist as functions but were never made
 * catalogue commands (the vector Object-menu entries); they carry their own
 * label and condition.
 */
export type ContextualAction =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "run"; readonly id: string; readonly label: LocalizedText; enabled(context: ContextualBarContext): boolean; run(context: ContextualBarContext): void };

export interface ContextualBarState {
  readonly id: string;
  /** Short caption at the start of the bar. */
  readonly label: LocalizedText;
  when(context: ContextualBarContext): boolean;
  readonly actions: readonly ContextualAction[];
}

const command = (id: string): ContextualAction => ({ kind: "command", command: id });

const raster = (context: ContextualBarContext): RasterDocumentState | null => isRasterDocumentState(context.state) ? context.state : null;
const activeLayer = (context: ContextualBarContext) => {
  const state = raster(context);
  return state?.layers.find((layer) => layer.id === state.activeLayerId) ?? null;
};

const vectorSelection = (context: ContextualBarContext): readonly string[] => isVectorDocumentState(context.state) ? context.state.selection : [];
const vectorActiveIsGroup = (context: ContextualBarContext): boolean => {
  const state = context.state;
  return isVectorDocumentState(state) && state.shapes.find((shape) => shape.id === state.activeShapeId)?.kind === "group";
};
const pathfinder = (op: "union" | "subtract" | "intersect" | "exclude", label: LocalizedText): ContextualAction => ({
  kind: "run",
  id: `vector.pathfinder.${op}`,
  label,
  enabled: (context) => vectorSelection(context).length >= 2,
  run: (context) => { void applyPathfinderOp(context.documentId, op); },
});

export const contextualBarStates: readonly ContextualBarState[] = [
  {
    // Photoshop: Modify selection ▸ Feather, Invert selection, Create mask,
    // Fill selection, Deselect. Transform Selection is left out: VRAVIO's
    // Free Transform moves the selected *pixels*, not the outline.
    id: "raster.selection",
    label: { en: "Selection", ru: "Выделение" },
    when: (context) => Boolean(raster(context)?.selection),
    actions: [command("select.feather"), command("select.invert"), command("layer.addMask"), command("edit.fillForeground"), command("select.none")],
  },
  {
    // Photoshop's mask bar: Invert, Disable/Enable, Delete, Apply mask.
    id: "raster.mask",
    label: { en: "Layer mask", ru: "Маска слоя" },
    when: (context) => {
      const state = raster(context);
      return Boolean(state && context.editingMaskLayerId && state.layers.find((layer) => layer.id === context.editingMaskLayerId)?.mask);
    },
    actions: [command("image.adjustment.invert"), command("layer.toggleMaskEnabled"), command("layer.applyMask"), command("layer.deleteMask")],
  },
  {
    id: "raster.layers",
    label: { en: "Layers", ru: "Слои" },
    // The active layer has to be part of the multi-selection: `layer.group`
    // makes the new group active without touching the panel's selection
    // (its own comment says why), so right after grouping the stale pair
    // would otherwise keep offering "Group" again instead of Ungroup.
    when: (context) => {
      const state = raster(context);
      return Boolean(state) && context.selectedLayerIds.length >= 2 && context.selectedLayerIds.includes(state!.activeLayerId);
    },
    actions: [command("layer.group")],
  },
  {
    id: "raster.group",
    label: { en: "Group", ru: "Группа" },
    when: (context) => activeLayer(context)?.kind === "group",
    actions: [command("layer.ungroup")],
  },
  {
    id: "raster.smartObject",
    label: { en: "Smart object", ru: "Смарт-объект" },
    when: (context) => activeLayer(context)?.kind === "smart",
    actions: [command("layer.editSmartObjectContents")],
  },
  {
    // Photoshop's no-selection pixel-layer bar: Select subject, Remove background.
    id: "raster.pixelLayer",
    label: { en: "Layer", ru: "Слой" },
    when: (context) => activeLayer(context)?.kind === "pixel",
    actions: [command("select.subject"), command("layer.removeBackground")],
  },
  {
    // §11.3's own example: Vector, two shapes → Union/Subtract/Intersect/Exclude.
    // Labels are the Object ▸ Pathfinder menu's, which has no catalogue commands.
    id: "vector.selection",
    label: { en: "Selection", ru: "Выделение" },
    when: (context) => vectorSelection(context).length >= 2 || vectorActiveIsGroup(context),
    actions: [
      { kind: "run", id: "vector.group", label: { en: "Group", ru: "Сгруппировать" }, enabled: (context) => vectorSelection(context).length >= 2, run: (context) => groupActiveVectorShapes(context.documentId) },
      {
        kind: "run", id: "vector.ungroup", label: { en: "Ungroup", ru: "Разгруппировать" },
        enabled: vectorActiveIsGroup,
        run: (context) => ungroupActiveVectorGroup(context.documentId),
      },
      pathfinder("union", { en: "Unite", ru: "Объединить" }),
      pathfinder("subtract", { en: "Subtract", ru: "Вычесть" }),
      pathfinder("intersect", { en: "Intersect", ru: "Пересечь" }),
      pathfinder("exclude", { en: "Exclude", ru: "Исключить" }),
    ],
  },
];

export interface ResolvedAction {
  readonly id: string;
  readonly label: LocalizedText;
  run(): void;
}

export interface ResolvedContextualBar {
  readonly state: ContextualBarState;
  readonly actions: readonly ResolvedAction[];
}

/**
 * The state that applies now and its enabled actions, or null for no bar.
 *
 * Commands run through `kernel.commands.execute` — the registry, so the
 * script recorder sees a bar click the same as a menu click — and their
 * enabled state is the definition's own `isEnabled`, the same question the
 * menu and palette ask.
 */
export function resolveContextualBar(context: ContextualBarContext): ResolvedContextualBar | null {
  const commandContext: CommandContext = { activeDocumentId: context.documentId };
  for (const state of contextualBarStates) {
    if (!state.when(context)) continue;
    const actions = state.actions.flatMap((action): ResolvedAction[] => {
      if (action.kind === "run") return action.enabled(context) ? [{ id: action.id, label: action.label, run: () => action.run(context) }] : [];
      const definition = commandDefinitionById.get(action.command);
      // A missing id is a renamed or deleted command; the contract test fails
      // on it, and at runtime the button is left out rather than doing nothing.
      if (!definition || definition.isEnabled?.(commandContext) === false) return [];
      return [{ id: definition.id, label: definition.label, run: () => { void kernel.commands.execute(definition.id, commandContext); } }];
    });
    if (actions.length) return { state, actions };
  }
  return null;
}

/**
 * What the bar sits next to, in document pixels — the selection's bounds, or
 * the active layer's own. Photoshop places its bar under the selection or
 * object; null means "no single thing to follow" and the bar keeps its
 * default spot.
 */
export function contextualAnchor(context: ContextualBarContext): { x: number; y: number; width: number; height: number } | null {
  const state = raster(context);
  if (!state) return null;
  if (state.selection) return state.selection.bounds;
  const layer = activeLayer(context);
  if (!layer || layer.kind === "group" || !layer.bounds.width || !layer.bounds.height) return null;
  return layer.bounds;
}
