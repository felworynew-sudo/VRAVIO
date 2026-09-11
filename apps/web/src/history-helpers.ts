import type { ReversibleOperation } from "@vravio/kernel";

/** A history step that merges with a same-labeled step recorded right after it — dragging a
 *  slider (or typing into a field) should not leave one undo entry per pointermove/keystroke,
 *  only per settle. Was defined identically in DockLayout.tsx and scene3d-commands.ts; kept in
 *  one place so a third property panel does not have to carry a fourth copy. */
export function mergeableEdit(label: string, undo: () => void, redo: () => void): ReversibleOperation {
  return { label, undo, redo, mergeWith: (next) => next.label === label ? mergeableEdit(label, undo, next.redo) : null };
}
