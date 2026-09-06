import { emptyVectorStyle } from "./appearance";
import { IDENTITY_MATRIX } from "./matrix";
import { appendShapeAt, reorderSiblings, siblingsOf, vectorShapeDescendantIds } from "./tree";
import { SYMBOLS_ROOT_ID, makeVectorOrderKey } from "./types";
import type { VectorDocumentState, VectorShape } from "./types";

/**
 * Stage 13 of docs/vector-plan.md. A symbol *definition* is nothing new: an
 * ordinary `group` shape, living in `state.shapes` exactly like any other,
 * just parented to `SYMBOLS_ROOT_ID` instead of the document root or a real
 * group — see that constant's own doc comment in types.ts for why that
 * alone is enough to keep it out of normal paint order, the layers panel,
 * and top-level hit-testing, with zero changes to any of the functions that
 * already walk `parentId` chains. `listSymbols` below is what a "Symbols"
 * panel enumerates; nothing else needs a second, parallel list of them.
 */

const find = (state: VectorDocumentState, id: string): VectorShape | undefined => state.shapes.find((shape) => shape.id === id);

let symbolCounter = 0;
let instanceCounter = 0;

/** A placed reference to a symbol's shared content — never a copy of it (see
 * the `instance` shape kind's own doc comment in types.ts). `transform`
 * alone controls where it sits; there is no x/y/width/height of its own,
 * the same way a `group` has none. */
export function createSymbolInstance(symbolId: string, name = "Instance (Экземпляр)"): VectorShape {
  instanceCounter += 1;
  return {
    id: `instance-${instanceCounter}`, kind: "instance", symbolId, name, visible: true, locked: false,
    style: emptyVectorStyle(), // an instance paints nothing of its own — its symbol's leaves do
    parentId: null, orderKey: "unassigned", transform: IDENTITY_MATRIX, geometry: [],
  };
}

/** Every symbol definition currently in the document, with how many
 * instances reference each — what a Symbols panel lists, and what "can this
 * be deleted without leaving a dangling reference behind" needs to check. */
export interface SymbolSummary { readonly id: string; readonly name: string; readonly instanceCount: number }

export function listSymbols(state: VectorDocumentState): SymbolSummary[] {
  const masters = siblingsOf(state.shapes, SYMBOLS_ROOT_ID);
  return masters.map((master) => ({
    id: master.id,
    name: master.name,
    instanceCount: state.shapes.filter((shape) => shape.kind === "instance" && shape.symbolId === master.id).length,
  }));
}

/**
 * Wraps the given shapes into a new symbol, in place: the selection's
 * content moves into a fresh master group parked in the symbol library
 * (`SYMBOLS_ROOT_ID`), and a single `instance` of it takes the selection's
 * old position in the tree — same visual result (the instance's transform
 * starts at identity, and the master's own content keeps every member's
 * original transform untouched, so nothing appears to move), same
 * "topmost member's parent wins" rule for a selection spanning more than
 * one level that `groupShapes` (group-ops.ts) already established, for the
 * same reason: there is no single unambiguous place to put a mixed-level
 * selection's replacement otherwise.
 */
export function createSymbolFromShapes(state: VectorDocumentState, ids: readonly string[], name = "Symbol (Символ)"): VectorShape | null {
  const members = ids.map((id) => find(state, id)).filter((shape): shape is VectorShape => Boolean(shape));
  if (members.length === 0) return null;
  const parentId = members[members.length - 1]!.parentId ?? null;
  const chosen = members.filter((shape) => (shape.parentId ?? null) === parentId);
  if (chosen.length === 0) return null;

  // Captured before anything moves — the "which non-chosen siblings sat
  // before the chosen run" split `groupShapes` also needs, computed here
  // first since (unlike that function) the master's own placeholder push
  // below goes to a different parent and would not itself show up in this
  // list regardless of when it happens.
  const peers = siblingsOf(state.shapes, parentId).filter((shape) => !chosen.some((member) => member.id === shape.id));
  const currentOrder = siblingsOf(state.shapes, parentId);
  const highest = currentOrder.findIndex((shape) => shape.id === chosen[chosen.length - 1]!.id);
  const before = peers.filter((shape) => currentOrder.indexOf(shape) < highest);

  symbolCounter += 1;
  const master: VectorShape = {
    id: `symbol-${symbolCounter}`, kind: "group", name, visible: true, locked: false,
    style: emptyVectorStyle(), parentId: SYMBOLS_ROOT_ID, orderKey: makeVectorOrderKey(siblingsOf(state.shapes, SYMBOLS_ROOT_ID).length),
    transform: IDENTITY_MATRIX, expanded: true, geometry: [],
  };
  state.shapes.push(master);

  const ordered = chosen.slice().sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  for (const member of ordered) (member as { parentId: string | null }).parentId = master.id;
  reorderSiblings(ordered);

  const instance = createSymbolInstance(master.id, name);
  appendShapeAt(state, instance, parentId);
  reorderSiblings([...before, instance, ...peers.filter((shape) => !before.includes(shape))]);

  state.activeShapeId = instance.id;
  state.selection = [instance.id];
  return instance;
}

/**
 * Converts an instance back into a real, independent group holding its own
 * deep copies of the symbol's current content — "Break Link" (Разорвать
 * связь). After this, editing the new group affects nothing else; editing
 * the symbol it used to reference no longer affects this shape either.
 */
export function detachInstance(state: VectorDocumentState, instanceId: string): VectorShape | null {
  const instance = find(state, instanceId);
  if (!instance || instance.kind !== "instance") return null;
  const master = find(state, instance.symbolId);
  if (!master || master.kind !== "group") return null;

  const group: VectorShape = {
    id: `${master.id}-detached-${instanceCounter}`, kind: "group", name: instance.name, visible: instance.visible, locked: instance.locked,
    style: emptyVectorStyle(), parentId: instance.parentId, orderKey: instance.orderKey, transform: instance.transform, expanded: true, geometry: [],
  };
  state.shapes.push(group);

  const copyOne = (shape: VectorShape, parentId: string | null): VectorShape => {
    instanceCounter += 1;
    const copy: VectorShape = { ...structuredClone(shape), id: `${shape.kind}-detached-${instanceCounter}`, parentId };
    state.shapes.push(copy);
    if (shape.kind === "group") for (const child of siblingsOf(state.shapes, shape.id)) copyOne(child, copy.id);
    return copy;
  };
  const children = siblingsOf(state.shapes, master.id).map((child) => copyOne(child, group.id));
  reorderSiblings(children);

  state.shapes = state.shapes.filter((shape) => shape.id !== instance.id);
  state.activeShapeId = group.id;
  state.selection = [group.id];
  return group;
}

/**
 * Replaces a symbol's own content with the given shapes — "Redefine Symbol"
 * (Переопределить символ). Every existing instance updates immediately and
 * automatically: an instance holds only `symbolId`, never a copy of what it
 * looks like, so there is nothing else to propagate. The given shapes move
 * into the definition (reparented, not copied) — same "author it on canvas
 * like anything else, then fold it in" flow `createSymbolFromShapes` uses to
 * make a symbol in the first place, just replacing an existing one's
 * content instead of creating a new definition.
 */
export function redefineSymbolFromShapes(state: VectorDocumentState, symbolId: string, sourceIds: readonly string[]): boolean {
  const master = find(state, symbolId);
  if (!master || master.kind !== "group") return false;
  const sources = sourceIds.map((id) => find(state, id)).filter((shape): shape is VectorShape => shape !== undefined && shape.id !== symbolId);
  if (sources.length === 0) return false;

  const oldChildIds = new Set(vectorShapeDescendantIds(state.shapes, master.id));
  state.shapes = state.shapes.filter((shape) => !oldChildIds.has(shape.id));

  const ordered = sources.slice().sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  for (const member of ordered) (member as { parentId: string | null }).parentId = master.id;
  reorderSiblings(ordered);
  return true;
}

/** Places a new instance of an existing symbol at the document's top level,
 * for the Symbols panel's own "place" action. `null` if `symbolId` does not
 * resolve to a real symbol (a stale panel row from a deleted one). */
export function placeSymbolInstance(state: VectorDocumentState, symbolId: string, x: number, y: number): VectorShape | null {
  const master = find(state, symbolId);
  if (!master || master.kind !== "group") return null;
  const instance = createSymbolInstance(symbolId, master.name);
  (instance as { transform: typeof instance.transform }).transform = { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
  appendShapeAt(state, instance, null);
  state.activeShapeId = instance.id;
  state.selection = [instance.id];
  return instance;
}
