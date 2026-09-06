/**
 * `Shift`'s 45°-angle constraint — factored out of `pen.tsx` (its original
 * home) once a second tool (`vector.line`, via `shape-drag.ts`) needed the
 * exact same math. One copy, not two independently-drifting ones — the
 * same "дубликат — это два будущих, которые разойдутся" this codebase
 * already states as a rule (CLAUDE.md §4) for exactly this shape of
 * duplication. 45°, not the 15° some other editors use — taken as given
 * from `docs/vector-plan.md`'s own spec for the pen gesture this was first
 * written for, not re-derived here.
 */

/** Rounds `angle` (radians) to the nearest multiple of 45°. */
function snapAngleTo45Degrees(angle: number): number {
  const step = Math.PI / 4;
  return Math.round(angle / step) * step;
}

/** Applies the 45°-angle constraint to a vector `(dx, dy)`, keeping its
 * length unchanged. */
export function constrainVectorTo45Degrees(dx: number, dy: number): { x: number; y: number } {
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  const angle = snapAngleTo45Degrees(Math.atan2(dy, dx));
  return { x: Math.cos(angle) * length, y: Math.sin(angle) * length };
}
