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

/** How much closer a *new* candidate has to be than the line already locked
 * in from the previous frame before it's allowed to take over — see
 * `resolveSnapForBounds`'s own doc comment on why this exists at all. 0.5
 * means a challenger has to beat the incumbent's distance by more than
 * half to win; the incumbent otherwise keeps its seat as long as it's still
 * within `radius` at all. */
const STICKY_FACTOR = 0.5;

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
 * That same richness is exactly what made dragging feel twitchy before
 * `previousLines`/`STICKY_FACTOR` existed: with three probes per axis and
 * several snap sources active at once, two candidate lines sitting a pixel
 * or two apart routinely have near-identical distances, and picking
 * whichever is *currently* closest with no memory of the last frame's
 * choice means the tiniest mouse movement can flip the winner back and
 * forth — the shape visibly jumps between two different targets instead of
 * tracking the pointer. `previousLines` (the caller's own last-frame
 * `SnapResult.lines`) breaks that tie in favor of whatever was already
 * locked in, unless a new candidate is closer by a real margin, not just a
 * rounding-sized one — the standard "stickiness" every mature snapping
 * implementation has, in one form or another, for the same reason.
 *
 * `radius` is in the same units as `bounds` and every `SnapLine` — document
 * units, not screen pixels. Converting a screen-pixel radius (what
 * docs/vector-plan.md's stage 5 checklist calls for) is the caller's job,
 * because only the caller knows the current zoom (see `VectorWorkspace.tsx`);
 * this function has no notion of a viewport at all.
 */
export function resolveSnapForBounds(bounds: VectorBounds, radius: number, sources: readonly SnapSource[], context: SnapContext, previousLines: readonly SnapLine[] = []): SnapResult {
  const lines = sources.flatMap((source) => source.collect(context));
  const probesX = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
  const probesY = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
  const isSticky = (line: SnapLine) => previousLines.some((previous) => previous.axis === line.axis && previous.value === line.value);

  let bestX: { distance: number; effectiveDistance: number; delta: number; line: SnapLine } | null = null;
  let bestY: { distance: number; effectiveDistance: number; delta: number; line: SnapLine } | null = null;

  for (const line of lines) {
    const probes = line.axis === "x" ? probesX : probesY;
    for (const probe of probes) {
      const distance = Math.abs(line.value - probe);
      if (distance > radius) continue;
      const effectiveDistance = isSticky(line) ? distance * STICKY_FACTOR : distance;
      const current = line.axis === "x" ? bestX : bestY;
      if (current && current.effectiveDistance <= effectiveDistance) continue;
      const candidate = { distance, effectiveDistance, delta: line.value - probe, line };
      if (line.axis === "x") bestX = candidate; else bestY = candidate;
    }
  }

  return {
    dx: bestX?.delta ?? 0,
    dy: bestY?.delta ?? 0,
    lines: [bestX?.line, bestY?.line].filter((line): line is SnapLine => Boolean(line)),
  };
}
