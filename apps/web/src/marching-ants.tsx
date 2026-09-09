import { useId, type CSSProperties, type ReactNode } from "react";
import { useShellStore } from "./store";

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
/** Screen pixels: how far the glow reaches inward, and how soft it is. Stroked
 * at twice the width because the clip throws the outward half away. */
const GLOW_WIDTH = 6;
const GLOW_BLUR = 3;

export function MarchingAnts({ zoom, children }: { zoom: number; children: ReactNode }) {
  // 4px dashes with 4px gaps, so one full cycle is 8px of travel — the donor's
  // pattern and period exactly, at 120ms a step over 8 steps.
  //
  // The period carries a unit on purpose.  as a CSS property
  // takes a <length>; a bare number is valid only as an SVG presentation
  // attribute. Written unitless the keyframe below was simply invalid, the
  // offset stayed at 0 forever, and the ants never marched — a dashed line that
  // holds still, which is what the owner saw. Inside the scaled stage a px here
  // is a user unit, the same space  is written in.
  const dash = 4 / zoom;
  const glow = useShellStore((shell) => shell.preferences.selectionGlow);
  // The clip has to be unique per instance: three overlays can be on screen at
  // once (a live marquee, the committed edge, the patch tool's lasso), and a
  // shared id would have them all clipping to whichever rendered last.
  const clipId = `selection-glow-clip-${useId()}`;
  return <g className="marching-ants" style={{ "--ant-period": `${8 / zoom}px` } as CSSProperties}>
    {/* Inward glow (off by default, Settings → Guides). Drawn first so the ants
        stay crisp on top of it, and clipped to the selection's own interior so
        it falls inward only — a plain wide stroke would spill both ways and read
        as a halo around the selection rather than a light inside it. Its width
        and blur are screen measurements divided by the zoom, which
        master-plan.md §1.8 makes an explicit condition of this feature. */}
    {glow && <>
      <clipPath id={clipId}>{children}</clipPath>
      <g clipPath={`url(#${clipId})`} className="selection-glow" strokeWidth={GLOW_WIDTH * 2 / zoom} style={{ filter: `blur(${GLOW_BLUR / zoom}px)` }}>{children}</g>
    </>}
    <g className="marching-ants-dark" strokeWidth={1 / zoom}>{children}</g>
    <g className="marching-ants-light" strokeWidth={1 / zoom} strokeDasharray={`${dash} ${dash}`}>{children}</g>
  </g>;
}
