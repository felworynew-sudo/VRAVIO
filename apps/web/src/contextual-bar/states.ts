import { isRasterDocumentState, type RasterDocumentState, type RasterLayer } from "@vravio/env-raster";
import { isVectorDocumentState, shapeWorldBounds } from "@vravio/env-vector";
import type { CommandContext } from "@vravio/kernel";
import { commandDefinitionById } from "../commands/registry";
import type { LocalizedText } from "../i18n";
import { kernel } from "../kernel";
import { applyPathfinderOp, groupActiveVectorShapes, ungroupActiveVectorGroup } from "../vector-commands";
import type { EditSession } from "./sessions";

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
  /** An open crop / Free Transform, published by its tool (`sessions.ts`). */
  readonly session?: EditSession | null;
}

/**
 * One button. A catalogue command wherever one exists — label and enabled
 * state then come from the catalogue, so the bar cannot drift from the menu.
 * `run` is only for operations that exist as functions but were never made
 * catalogue commands (the vector Object-menu entries); they carry their own
 * label and condition. `menu` is Photoshop's dropdown buttons ("Modify
 * selection ▾"): a label over a list of actions, shown only while at least
 * one of them is enabled.
 */
export type ContextualAction = ActionLook & (
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "run"; readonly id: string; readonly label: LocalizedText; enabled(context: ContextualBarContext): boolean; run(context: ContextualBarContext): void }
  | { readonly kind: "menu"; readonly id: string; readonly label: LocalizedText; readonly items: readonly ContextualAction[] }
);

/**
 * How a button looks. Photoshop's bar is a compact pill of icon buttons with
 * the name in a tooltip, plus one or two text buttons for the state's main
 * action ("Select subject", "Remove background", "Generative fill"); the owner
 * found a bar of text buttons spanning the canvas unusable. So: `icon` (a file
 * from the project's own `icons/` set) shows alone with the label as tooltip;
 * `primary` also shows the label. An item inside a dropdown list always shows
 * its label.
 */
export interface ActionLook {
  readonly icon?: string;
  readonly primary?: boolean;
  /** Draw the icon mirrored — one rotate arrow serves both directions. */
  readonly mirror?: boolean;
}

export interface ContextualBarState {
  readonly id: string;
  /** Short caption at the start of the bar. */
  readonly label: LocalizedText;
  when(context: ContextualBarContext): boolean;
  readonly actions: readonly ContextualAction[];
}

const command = (id: string, look: ActionLook = {}): ContextualAction => ({ kind: "command", command: id, ...look });

const raster = (context: ContextualBarContext): RasterDocumentState | null => isRasterDocumentState(context.state) ? context.state : null;
const activeLayer = (context: ContextualBarContext) => {
  const state = raster(context);
  return state?.layers.find((layer) => layer.id === state.activeLayerId) ?? null;
};

/**
 * Whether a pixel layer has anything on it.
 *
 * `setLayerPixels` trims a layer to its opaque content, and a layer with none
 * left keeps the 1×1 fully transparent rectangle `trimToContent` returns as its
 * sentinel — that is the case this checks, with one `readPixel`, no document
 * scan. Photoshop's own bar offers Generate Image on an empty layer, which
 * VRAVIO has no backend for, so the honest answer here is no bar at all.
 * A never-edited layer still carries the canvas-sized bounds it was created
 * with, and is not detected as empty; finding that out costs a full scan.
 */
function layerHasContent(layer: RasterLayer): boolean {
  if (layer.kind !== "pixel") return true;
  const { width, height } = layer.bounds;
  if (width > 1 || height > 1) return true;
  if (layer.tiles.evicted) return true;
  return (layer.tiles.readPixel(0, 0)[3] ?? 0) > 0;
}

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

const sessionAction = (id: string, label: LocalizedText, look: ActionLook, enabled: (session: EditSession) => boolean, run: (session: EditSession) => void): ContextualAction => ({
  kind: "run", id, label, ...look,
  enabled: (context) => Boolean(context.session && enabled(context.session)),
  run: (context) => { if (context.session) run(context.session); },
});
const cancelSession = sessionAction("session.cancel", { en: "Cancel", ru: "Отмена" }, { primary: true }, () => true, (session) => session.cancel());
const commitSession = sessionAction("session.commit", { en: "Done", ru: "Готово" }, { primary: true }, () => true, (session) => session.commit());

export const contextualBarStates: readonly ContextualBarState[] = [
  {
    // Photoshop's transform bar (owner's screenshot, master-plan §58.3): Rotate 90° CCW, Rotate
    // 90° CW, Flip Horizontal, Flip Vertical, Cancel, Done. The flips are not here: VRAVIO's
    // transform session (`PendingTransform.live`) has no mirror term, and the places that
    // resample it at commit would all need one — see master-plan §11's note.
    id: "raster.transform",
    label: { en: "Transform", ru: "Трансформирование" },
    when: (context) => context.session?.kind === "transform",
    actions: [
      sessionAction("transform.rotateCcw", { en: "Rotate 90° counter-clockwise", ru: "Повернуть на 90° против часовой" }, { icon: "ВРАЩЕНИЕ ВИДА.svg", mirror: true }, (session) => Boolean(session.rotate), (session) => session.rotate?.(-90)),
      sessionAction("transform.rotateCw", { en: "Rotate 90° clockwise", ru: "Повернуть на 90° по часовой" }, { icon: "ВРАЩЕНИЕ ВИДА.svg" }, (session) => Boolean(session.rotate), (session) => session.rotate?.(90)),
      cancelSession,
      commitSession,
    ],
  },
  {
    // Crop: the same Enter / Escape pair as buttons.
    id: "raster.crop",
    label: { en: "Crop", ru: "Кадрирование" },
    when: (context) => context.session?.kind === "crop",
    actions: [cancelSession, commitSession],
  },
  {
    // Photoshop: Modify selection ▸ Feather, Invert selection, Create mask,
    // Transform selection (outline only), Fill selection, Deselect.
    id: "raster.selection",
    label: { en: "Selection", ru: "Выделение" },
    when: (context) => Boolean(raster(context)?.selection),
    actions: [
      { kind: "menu", id: "select.modify", icon: "ПАРАМЕТРЫ.svg", label: { en: "Modify selection", ru: "Изменить выделение" }, items: [command("select.feather"), command("select.expand", { icon: "РАЗДУТИЕ.svg" }), command("select.contract", { icon: "СЖАТИЕ.svg" }), command("select.smooth", { icon: "СГЛАЖИВАНИЕ.svg" })] },
      command("select.invert", { icon: "ИНВЕРСИЯ-КОРР.svg" }), command("select.transform", { icon: "УГОЛЬНИК.svg" }), command("layer.addMask", { icon: "МАСКА СЛОЯ.svg" }), command("edit.fillForeground", { icon: "Заливка.svg" }), command("select.none", { icon: "КРЕСТ.svg" }),
    ],
  },
  {
    // Photoshop's mask bar: Invert, Disable/Enable, Delete, Apply mask.
    id: "raster.mask",
    label: { en: "Layer mask", ru: "Маска слоя" },
    when: (context) => {
      const state = raster(context);
      return Boolean(state && context.editingMaskLayerId && state.layers.find((layer) => layer.id === context.editingMaskLayerId)?.mask);
    },
    actions: [command("image.adjustment.invert", { icon: "ИНВЕРСИЯ-КОРР.svg" }), command("layer.toggleMaskEnabled", { icon: "ГЛАЗ ЗАКРЫТ.svg" }), command("layer.applyMask", { icon: "ГАЛОЧКА.svg" }), command("layer.deleteMask", { icon: "КОРЗИНА.svg" })],
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
    actions: [command("layer.group", { icon: "ГРУППА.svg", primary: true })],
  },
  {
    id: "raster.group",
    label: { en: "Group", ru: "Группа" },
    when: (context) => activeLayer(context)?.kind === "group",
    actions: [command("layer.ungroup", { icon: "ГРУППА.svg", primary: true })],
  },
  {
    id: "raster.smartObject",
    label: { en: "Smart object", ru: "Смарт-объект" },
    when: (context) => activeLayer(context)?.kind === "smart",
    actions: [command("layer.editSmartObjectContents", { icon: "СЛОЙ-СМАРТ.svg", primary: true })],
  },
  {
    // Photoshop's no-selection pixel-layer bar: Select subject, Remove background.
    id: "raster.pixelLayer",
    label: { en: "Layer", ru: "Слой" },
    when: (context) => { const layer = activeLayer(context); return layer?.kind === "pixel" && layerHasContent(layer); },
    actions: [command("select.subject", { icon: "ВЫДЕЛЕНИЕ ОБЪЕКТА ИИ.svg", primary: true }), command("layer.removeBackground", { icon: "УДАЛЕНИЕ ОБЪЕКТА.svg", primary: true })],
  },
  {
    // §11.3's own example: Vector, two shapes → Union/Subtract/Intersect/Exclude.
    // Labels are the Object ▸ Pathfinder menu's, which has no catalogue commands.
    id: "vector.selection",
    label: { en: "Selection", ru: "Выделение" },
    when: (context) => vectorSelection(context).length >= 2 || vectorActiveIsGroup(context),
    actions: [
      { kind: "run", id: "vector.group", icon: "ГРУППА.svg", label: { en: "Group", ru: "Сгруппировать" }, enabled: (context) => vectorSelection(context).length >= 2, run: (context) => groupActiveVectorShapes(context.documentId) },
      {
        kind: "run", id: "vector.ungroup", icon: "ГРУППА.svg", primary: true, label: { en: "Ungroup", ru: "Разгруппировать" },
        enabled: vectorActiveIsGroup,
        run: (context) => ungroupActiveVectorGroup(context.documentId),
      },
      {
        kind: "menu", id: "vector.pathfinder", icon: "ПЕРЕСЕЧЕНИЕ.svg", label: { en: "Pathfinder", ru: "Обработка контуров" },
        items: [
          pathfinder("union", { en: "Unite", ru: "Объединить" }),
          pathfinder("subtract", { en: "Subtract", ru: "Вычесть" }),
          pathfinder("intersect", { en: "Intersect", ru: "Пересечь" }),
          pathfinder("exclude", { en: "Exclude", ru: "Исключить" }),
        ],
      },
    ],
  },
];

export interface ResolvedAction {
  readonly id: string;
  readonly label: LocalizedText;
  run(): void;
  /** Present for a dropdown: `run` is then unused and the bar lists these. */
  readonly items?: readonly ResolvedAction[];
  readonly icon?: string;
  readonly primary?: boolean;
  readonly mirror?: boolean;
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
    const resolve = (action: ContextualAction): ResolvedAction[] => {
      const look = { ...(action.icon ? { icon: action.icon } : {}), ...(action.primary ? { primary: true } : {}), ...(action.mirror ? { mirror: true } : {}) };
      if (action.kind === "run") return action.enabled(context) ? [{ id: action.id, label: action.label, run: () => action.run(context), ...look }] : [];
      if (action.kind === "menu") {
        const items = action.items.flatMap(resolve);
        return items.length ? [{ id: action.id, label: action.label, run: () => {}, items, ...look }] : [];
      }
      const definition = commandDefinitionById.get(action.command);
      // A missing id is a renamed or deleted command; the contract test fails
      // on it, and at runtime the button is left out rather than doing nothing.
      if (!definition || definition.isEnabled?.(commandContext) === false) return [];
      return [{ id: definition.id, label: definition.label, run: () => { void kernel.commands.execute(definition.id, commandContext); }, ...look }];
    };
    const actions = state.actions.flatMap(resolve);
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
  const frame = context.session?.frame?.();
  if (frame) return frame;
  const vector = context.state;
  if (isVectorDocumentState(vector)) {
    // The selected shapes' own box, so the bar follows a vector object the way
    // it follows a raster selection.
    const chosen = vector.shapes.filter((shape) => vector.selection.includes(shape.id));
    if (!chosen.length) return null;
    const boxes = chosen.map((shape) => shapeWorldBounds(shape, vector.shapes));
    const x = Math.min(...boxes.map((box) => box.x)), y = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width)), bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  }
  const state = raster(context);
  if (!state) return null;
  if (state.selection) return state.selection.bounds;
  const layer = activeLayer(context);
  if (!layer || layer.kind === "group" || !layer.bounds.width || !layer.bounds.height) return null;
  return layer.bounds;
}
