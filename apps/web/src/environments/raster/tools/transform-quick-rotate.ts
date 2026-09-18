import { pendingBounds, type PendingTransform } from "./definitions/move";

/**
 * Photoshop's transform bar buttons "Rotate 90° counter-clockwise / clockwise",
 * applied to an open Free Transform (master-plan §58.3).
 *
 * Kept out of `move.tsx` on purpose (another session owns it). It adds nothing
 * the tool does not already do: a rotate-handle drag produces
 * `{ ...pending, rotation: angle, live: { source, target, rotation: angle } }`
 * from the session the pending transform describes (`sessionFor`: `live`, or
 * the frame's own bounds as both source and target), and this produces exactly
 * that with the angle stepped by 90°. Nothing is resampled until commit, the
 * same as a drag — so four clicks come back to the original pixels.
 *
 * Not offered in Skew/Distort/Perspective (`corners`) or Warp (`mesh`): those
 * sessions have no single angle to step.
 */
export function canQuickRotate(pending: PendingTransform): boolean {
  return !pending.corners && !pending.mesh;
}

export function quickRotatePending(pending: PendingTransform, documentWidth: number, documentHeight: number, degrees: 90 | -90): PendingTransform | null {
  if (!canQuickRotate(pending)) return null;
  const normalise = (angle: number) => ((angle % 360) + 540) % 360 - 180;
  // A text transform turns about its own target bounds, as its rotate drag does.
  if (pending.text) return { ...pending, rotation: normalise(pending.rotation + degrees) };
  const bounds = pending.live ? null : pendingBounds(pending, documentWidth, documentHeight);
  const session = pending.live ?? (bounds ? { source: { ...bounds }, target: { ...bounds }, rotation: pending.rotation } : null);
  if (!session) return null;
  const rotation = normalise(session.rotation + degrees);
  return { ...pending, rotation, live: { source: session.source, target: session.target, rotation } };
}

/**
 * Photoshop's "Flip Horizontal" / "Flip Vertical" on an open Free Transform — the bar buttons and
 * the right-click menu (docs/master-plan.md §58.3).
 *
 * A flip is a term of the session's description, like its angle: `live.flipX`/`flipY` change where
 * each destination pixel reads from, so flipping twice is not flipped and nothing is resampled
 * until commit. Not offered for a type layer (its transform is described by its own bounds, with
 * no mirror term) nor in Skew/Distort/Perspective/Warp, whose corners already say where every
 * pixel goes.
 */
export function canQuickFlip(pending: PendingTransform): boolean {
  return !pending.corners && !pending.mesh && !pending.text;
}

export function quickFlipPending(pending: PendingTransform, documentWidth: number, documentHeight: number, axis: "x" | "y"): PendingTransform | null {
  if (!canQuickFlip(pending)) return null;
  const bounds = pending.live ? null : pendingBounds(pending, documentWidth, documentHeight);
  const session = pending.live ?? (bounds ? { source: { ...bounds }, target: { ...bounds }, rotation: pending.rotation } : null);
  if (!session) return null;
  return {
    ...pending,
    live: {
      ...session,
      flipX: axis === "x" ? !session.flipX : session.flipX ?? false,
      flipY: axis === "y" ? !session.flipY : session.flipY ?? false,
    },
  };
}
