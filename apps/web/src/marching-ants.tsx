import type { CSSProperties, ReactNode } from "react";

/**
 * The classic Photoshop selection edge: alternating black and white dashes that
 * crawl along the outline.
 *
 * Ported from Patchy's `stroke_marching_ants` (canvas_widget_selection.cpp),
 * including the part that is not obvious — the black is drawn as a *solid* pass
 * underneath the animated white dashes, not as the complementary dash pattern.
 * Both produce identical pixels along the stroke (the visible black runs are
 * exactly the gaps in the white pattern, so the black appears to march too),
 * but the solid underlay keeps the dark outline continuous however the dash
 * phase happens to land on a short subpath. A selection loop only a few pixels
 * around would otherwise blink out entirely for half of every cycle.
 *
 * What was here before was a single half-transparent white line with a blurred
 * copy under it: legible, but not ants — it never moved and had no dashes at
 * all, which is what the owner reported (master-plan.md §1.8).
 *
 * The geometry is given as children and rendered twice, so the two passes can
 * never disagree about what shape they are drawing. Sizes are screen
 * measurements divided by the zoom, since this draws inside `.raster-stage` and
 * that element carries the zoom's CSS transform — the rule CLAUDE.md §1 states
 * and `zoom-invariant-ui.test.ts` enforces.
 */
export function MarchingAnts({ zoom, children }: { zoom: number; children: ReactNode }) {
  // 4px dashes with 4px gaps, so one full cycle is 8px of travel — the donor's
  // pattern and period exactly, at 120ms a step over 8 steps.
  const dash = 4 / zoom;
  return <g className="marching-ants" style={{ "--ant-period": `${8 / zoom}` } as CSSProperties}>
    <g className="marching-ants-dark" strokeWidth={1 / zoom}>{children}</g>
    <g className="marching-ants-light" strokeWidth={1 / zoom} strokeDasharray={`${dash} ${dash}`}>{children}</g>
  </g>;
}
