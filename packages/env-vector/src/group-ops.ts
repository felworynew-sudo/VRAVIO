import { IDENTITY_MATRIX, multiplyMatrix } from "./matrix";
import { appendShapeAt, reorderSiblings, siblingsOf } from "./tree";
import { makeVectorOrderKey } from "./types";
import type { VectorDocumentState, VectorShape } from "./types";

let counter = 0;
function nextGroupId(): string { counter += 1; return `group-${counter}`; }

export function createVectorGroup(name = "Group (Группа)"): VectorShape {
  return {
    id: nextGroupId(), kind: "group", name, visible: true, locked: false,
    style: { fill: null, stroke: null, strokeWidth: 0, opacity: 1 },
    parentId: null, orderKey: makeVectorOrderKey(0), transform: IDENTITY_MATRIX, expanded: true,
  };
}

const find = (state: VectorDocumentState, id: string): VectorShape | undefined => state.shapes.find((shape) => shape.id === id);

/**
 * Wraps the given shapes in a new group, in place — mirrors
 * `packages/env-raster/src/layer-ops.ts`'s `groupLayers` exactly, including
 * "the topmost member's parent wins" for a selection spanning more than one
 * level (there is no single place to put a group otherwise).
 *
 * Grouping alone never moves anything: the new group starts at identity
 * transform, and every member keeps its own untouched `transform` and local
 * geometry, only gaining a new `parentId`. Nothing here needs to know what a
 * rectangle's `x`/`y` mean or how a path's points are laid out — that is
 * exactly what putting the transform on `VectorShapeBase` instead of
 * reinventing it per shape kind buys back.
 */
export function groupShapes(state: VectorDocumentState, ids: readonly string[], name = "Group (Группа)"): VectorShape | null {
  const members = ids.map((id) => find(state, id)).filter((shape): shape is VectorShape => Boolean(shape));
  if (members.length === 0) return null;
  const parentId = members[members.length - 1]!.parentId ?? null;
  const chosen = members.filter((shape) => (shape.parentId ?? null) === parentId);
  if (chosen.length === 0) return null;

  const group = createVectorGroup(name);
  appendShapeAt(state, group, parentId);

  const peers = siblingsOf(state.shapes, parentId).filter((shape) => shape.id !== group.id && !chosen.some((member) => member.id === shape.id));
  const highest = siblingsOf(state.shapes, parentId).findIndex((shape) => shape.id === chosen[chosen.length - 1]!.id);
  const before = peers.filter((shape) => siblingsOf(state.shapes, parentId).indexOf(shape) < highest);
  reorderSiblings([...before, group, ...peers.filter((shape) => !before.includes(shape))]);

  const ordered = chosen.slice().sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  for (const member of ordered) (member as { parentId: string | null }).parentId = group.id;
  reorderSiblings(ordered);

  state.activeShapeId = group.id;
  state.selection = [group.id];
  return group;
}

/**
 * Dissolves a group, leaving its contents exactly where they visually were.
 *
 * The group's own transform is composed into each child's, in place of the
 * `<g transform>` wrapper the renderer used while the group existed — the
 * live check this stage's plan calls for (group, rotate the group, ungroup —
 * shapes stay where they were) is exactly this: `multiplyMatrix` is
 * associative, so moving the same matrix from the parent slot into the
 * child's own slot changes nothing about where a point in the child's local
 * geometry ends up in document space.
 *
 * `state.activeShapeId` inheritance mirrors `ungroupLayer`'s fix in
 * `packages/env-raster/src/layer-ops.ts` line for line: an empty group is not
 * a rare shape (the layers panel's own "New Group" makes one and selects it),
 * and leaving `activeShapeId` pointing at the just-removed group is exactly
 * the bug that once left the raster workspace throwing "Active raster layer
 * is missing" on a blank screen.
 */
export function ungroupShapes(state: VectorDocumentState, groupId: string): boolean {
  const group = find(state, groupId);
  if (!group || group.kind !== "group") return false;
  const children = siblingsOf(state.shapes, group.id);
  const parentId = group.parentId ?? null;
  const peers = siblingsOf(state.shapes, parentId);
  const at = peers.findIndex((shape) => shape.id === group.id);

  for (const child of children) {
    (child as { parentId: string | null }).parentId = parentId;
    (child as { transform: typeof group.transform }).transform = multiplyMatrix(group.transform, child.transform);
  }
  reorderSiblings([...peers.slice(0, at), ...children, ...peers.slice(at + 1)]);
  state.shapes = state.shapes.filter((shape) => shape.id !== group.id);

  if (state.activeShapeId === group.id) {
    state.activeShapeId = children[children.length - 1]?.id
      ?? peers[at + 1]?.id ?? peers[at - 1]?.id
      ?? state.shapes[state.shapes.length - 1]?.id
      ?? state.activeShapeId;
  }
  state.selection = state.selection.filter((id) => id !== group.id).length
    ? state.selection.filter((id) => id !== group.id)
    : children.map((child) => child.id);
  return true;
}
