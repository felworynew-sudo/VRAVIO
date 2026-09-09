import type { VectorBounds } from "@vravio/env-vector";

/**
 * Photoshop's own selection rules, which is what the owner asked for, kept
 * apart from the pointer plumbing so they can be read and tested as rules.
 *
 * Researched rather than assumed — Adobe's community answers and Julieanne
 * Kost's write-up on drag-selecting layers. With the Move tool:
 *
 * - a plain click selects what is under the pointer;
 * - Shift-click *toggles* — "holding shift and clicking over a layer can add or
 *   remove layers in a group of selected layers" — except that it will not
 *   empty the selection: shift-clicking the last remaining object leaves it
 *   selected, which is why clicking the same object twice with Shift is a
 *   round trip rather than a way to end up with nothing;
 * - dragging from empty space rubber-bands, and everything the band reaches
 *   comes along ("any layer that falls inside the marquee is selected") —
 *   touching, not full containment, which is also Illustrator's rule and the
 *   one that makes a band swept across a row pick up all of it;
 * - Shift+drag adds the band's catch to what was selected; a plain drag
 *   replaces it, and an empty band clears the selection;
 * - clicking an object already part of a multiple selection drags the whole
 *   selection instead of collapsing it to that one.
 */

/** What a press decides: what ends up selected, and whether a move drag starts. */
export function resolveSelectionPress(
  hitId: string | null,
  selection: readonly string[],
  shiftKey: boolean,
): { selection: readonly string[]; drag: boolean } {
  // Empty space starts a band. The selection is left alone until the band comes
  // up — clearing it here would lose a selection the user is about to add to.
  if (!hitId) return { selection, drag: false };
  if (!shiftKey) return { selection: selection.includes(hitId) ? selection : [hitId], drag: true };
  if (!selection.includes(hitId)) return { selection: [...selection, hitId], drag: true };
  if (selection.length === 1) return { selection, drag: true };
  return { selection: selection.filter((id) => id !== hitId), drag: false };
}

/** What a rubber band catches, given what was selected when it started. */
export function resolveMarqueeRelease(
  caught: readonly string[],
  selectionAtPress: readonly string[],
  additive: boolean,
): readonly string[] {
  if (!additive) return caught;
  const merged = [...selectionAtPress];
  for (const id of caught) if (!merged.includes(id)) merged.push(id);
  return merged;
}

/** Axis-aligned overlap; touching counts, per the band rule above. */
export function rectsOverlap(a: VectorBounds, b: VectorBounds): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/** The rectangle between two corners, whichever way the drag went. */
export function rectBetween(from: { x: number; y: number }, to: { x: number; y: number }): VectorBounds {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

/**
 * A drag held with Shift runs along one axis — the raster Move tool's own
 * constraint, and the reason this is here rather than inline: "moving a thing"
 * should mean the same in both environments.
 */
export function constrainToAxis(dx: number, dy: number, shiftKey: boolean): { x: number; y: number } {
  if (!shiftKey) return { x: dx, y: dy };
  return Math.abs(dx) >= Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy };
}
