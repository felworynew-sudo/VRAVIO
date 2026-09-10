/**
 * Stamping for Photoshop's Selection Brush (shortcut L, shares the Lasso
 * group): paint to grow a selection, Alt-paint to shrink it, live, within
 * the same stroke.
 *
 * Same soft round/elliptical brush-tip math as `spotHealDab`/
 * `spotHealStrokeSegment` (spot_heal.ts) — reused, not reinvented, per
 * CLAUDE.md's "search first" rule, the donor here being this codebase's own
 * spot-healing brush. The one thing that math cannot do as written is
 * subtract: `spotHealDab` only ever raises a mask (`Math.max`), correct for
 * accumulating a heal area you are always adding to, wrong for a tool whose
 * whole point is erasing what you just painted, in the same stroke, the
 * instant you hold Alt — so `mode` picks the coverage direction per dab
 * instead of always taking the max.
 */

export function selectionBrushDab(
  mask: Uint8ClampedArray,
  maskWidth: number,
  maskHeight: number,
  targetX: number,
  targetY: number,
  size: number,
  hardness = 100,
  roundness = 100,
  angleDegrees = 0,
  mode: "add" | "subtract" = "add"
): void {
  const radius = Math.max(0.5, size / 2);
  const shortRadius = Math.max(0.5, radius * Math.max(0.01, Math.min(1, roundness / 100)));
  const hardnessFraction = Math.max(0, Math.min(1, hardness / 100));
  const radians = (angleDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);

  const left = Math.max(0, Math.floor(targetX - radius));
  const right = Math.min(maskWidth - 1, Math.ceil(targetX + radius));
  const top = Math.max(0, Math.floor(targetY - radius));
  const bottom = Math.min(maskHeight - 1, Math.ceil(targetY + radius));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const dx = x + 0.5 - targetX;
      const dy = y + 0.5 - targetY;
      const rx = dx * cosine + dy * sine;
      const ry = -dx * sine + dy * cosine;
      const distance = Math.hypot(rx / radius, ry / shortRadius);
      if (distance > 1) continue;

      const coverage = distance <= hardnessFraction
        ? 1
        : 1 - (distance - hardnessFraction) / Math.max(0.0001, 1 - hardnessFraction);

      const idx = y * maskWidth + x;
      const value = Math.round(coverage * 255);
      mask[idx] = mode === "add"
        ? Math.max(mask[idx]!, value)
        : Math.round((mask[idx]! * (255 - value)) / 255);
    }
  }
}

export function selectionBrushStrokeSegment(
  mask: Uint8ClampedArray,
  maskWidth: number,
  maskHeight: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  size: number,
  hardness = 100,
  roundness = 100,
  angleDegrees = 0,
  mode: "add" | "subtract" = "add",
  /** Gap between dabs as a fraction of the tip — the same units the brush and clone stroke use. */
  spacing = 0.18
): void {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, size * Math.max(0.01, spacing))));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    selectionBrushDab(
      mask, maskWidth, maskHeight,
      fromX + (toX - fromX) * t, fromY + (toY - fromY) * t,
      size, hardness, roundness, angleDegrees, mode
    );
  }
}
