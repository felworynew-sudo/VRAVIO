import type { VectorBounds } from "../shape-ops";
import type { SnapContext, SnapLine, SnapSource } from "./types";

export interface SnapResult {
  /** How far to move the dragged bounds on each axis to land exactly on the
   * best matching line — 0 when nothing on that axis was within `radius`. */
  readonly dx: number;
  readonly dy: number;
  /** The line(s) actually matched, for a caller to highlight — at most one
   * per axis, since only the closest candidate per axis wins. */
  readonly lines: readonly SnapLine[];
}

/**
 * Where a dragged shape's world bounds should land, given every snap
 * source's candidate lines.
 *
 * Three points per axis are tested against every line — a bounding box's
 * two edges and its center — because "smart guides" means exactly this in
 * every editor that has them: a shape aligns not just when its top-left
 * corner matches something, but when its *center* lines up with another
 * shape's center, or its right edge with another's left edge. Testing only
 * one probe point (say, the top-left corner) would silently miss the other
 * two-thirds of the alignments a user expects to feel.
 *
 * `radius` is in the same units as `bounds` and every `SnapLine` — document
 * units, not screen pixels. Converting a screen-pixel radius (what
 * docs/vector-plan.md's stage 5 checklist calls for) is the caller's job,
 * because only the caller knows the current zoom (see `VectorWorkspace.tsx`);
 * this function has no notion of a viewport at all.
 */
export function resolveSnapForBounds(bounds: VectorBounds, radius: number, sources: readonly SnapSource[], context: SnapContext): SnapResult {
  const lines = sources.flatMap((source) => source.collect(context));
  const probesX = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
  const probesY = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];

  let bestX: { distance: number; delta: number; line: SnapLine } | null = null;
  let bestY: { distance: number; delta: number; line: SnapLine } | null = null;

  for (const line of lines) {
    const probes = line.axis === "x" ? probesX : probesY;
    for (const probe of probes) {
      const distance = Math.abs(line.value - probe);
      if (distance > radius) continue;
      const current = line.axis === "x" ? bestX : bestY;
      if (current && current.distance <= distance) continue;
      const candidate = { distance, delta: line.value - probe, line };
      if (line.axis === "x") bestX = candidate; else bestY = candidate;
    }
  }

  return {
    dx: bestX?.delta ?? 0,
    dy: bestY?.delta ?? 0,
    lines: [bestX?.line, bestY?.line].filter((line): line is SnapLine => Boolean(line)),
  };
}
