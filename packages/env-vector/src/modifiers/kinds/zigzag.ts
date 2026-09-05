import { parseFlatPolygon, polygonToSvgPath } from "../svg-path";
import type { ModifierDefinition, ZigzagModifier } from "../types";

/**
 * Replaces every straight edge with a zigzag of the given amplitude,
 * alternating left/right of the original edge every `segmentLength` —
 * Illustrator's own "Zig Zag" effect, minus its smooth-curve variant (this
 * is corners only, matching the plan's own "modifier stack, first ones"
 * wording rather than expanding scope with an option nothing asked for).
 */
export const zigzag: ModifierDefinition<ZigzagModifier> = {
  kind: "zigzag",
  apply(d, modifier) {
    const { points, closed } = parseFlatPolygon(d);
    if (points.length < 2 || modifier.amplitude <= 0 || modifier.segmentLength <= 0) return d;
    const count = points.length;
    const edgeCount = closed ? count : count - 1;
    const output: { x: number; y: number }[] = [points[0]!];

    for (let i = 0; i < edgeCount; i += 1) {
      const from = points[i]!;
      const to = points[(i + 1) % count]!;
      const dx = to.x - from.x, dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      const steps = Math.max(1, Math.round(length / modifier.segmentLength));
      const nx = -dy / length, ny = dx / length; // unit normal
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const baseX = from.x + dx * t, baseY = from.y + dy * t;
        const isLast = step === steps;
        const side = isLast ? 0 : step % 2 === 1 ? 1 : -1;
        output.push({ x: baseX + nx * modifier.amplitude * side, y: baseY + ny * modifier.amplitude * side });
      }
    }
    return polygonToSvgPath(output, closed);
  },
};

export default zigzag;
