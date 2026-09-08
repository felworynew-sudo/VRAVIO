/**
 * Pure geometry for compositing one clip's source frame onto the document canvas — no `<canvas>`
 * or `<video>` element touched here, so it is testable under Node the same way every other
 * calculation in this package is (docs/migration-plan.md §2's engine/DOM boundary). The caller
 * (`VideoWorkspace.tsx`'s compositor, in apps/web) is the one that actually calls
 * `CanvasRenderingContext2D.drawImage` with the numbers this produces.
 *
 * The model, in order:
 * 1. Crop away a fraction of each edge of the *source* frame (`VideoClip.cropLeft/Top/Right/
 *    Bottom`), producing the cropped source rectangle actually sampled.
 * 2. Fit that cropped rectangle inside the document, preserving its aspect ratio and centering
 *    it (`object-fit: contain`) — this is the clip's rect at `scale: 1, x: 0, y: 0`.
 * 3. Apply the clip's own `scale` (grows/shrinks around the fitted rect's own center, not the
 *    document's corner) and `x`/`y` (a pixel offset from that centered position).
 */
import type { VideoClip } from "./types";

export interface SourceRect {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

export interface DestRect {
  readonly dx: number;
  readonly dy: number;
  readonly dw: number;
  readonly dh: number;
}

/** The cropped rectangle of the *source* frame this clip actually samples, in the source's own
 * pixel coordinates. Degenerates to a 1×1 rect (never 0×0 — nothing valid to sample) if the crop
 * fractions would otherwise leave nothing. */
export function sourceRectFor(clip: Pick<VideoClip, "sourceWidth" | "sourceHeight" | "cropLeft" | "cropTop" | "cropRight" | "cropBottom">): SourceRect {
  const sx = clip.cropLeft * clip.sourceWidth, sy = clip.cropTop * clip.sourceHeight;
  const sw = Math.max(1, clip.sourceWidth * (1 - clip.cropLeft - clip.cropRight));
  const sh = Math.max(1, clip.sourceHeight * (1 - clip.cropTop - clip.cropBottom));
  return { sx, sy, sw, sh };
}

/** Where that cropped source rectangle lands on the document canvas, honoring the clip's own
 * `scale`/`x`/`y` transform. `docWidth`/`docHeight` are the document's own frame size. */
export function destRectFor(clip: Pick<VideoClip, "x" | "y" | "scale">, source: SourceRect, docWidth: number, docHeight: number): DestRect {
  const fitScale = source.sw > 0 && source.sh > 0 ? Math.min(docWidth / source.sw, docHeight / source.sh) : 1;
  const fitW = source.sw * fitScale, fitH = source.sh * fitScale;
  const fitX = (docWidth - fitW) / 2, fitY = (docHeight - fitH) / 2;

  const dw = fitW * clip.scale, dh = fitH * clip.scale;
  // Scaling grows/shrinks around the fitted rect's own center, so the clip stays centered on its
  // default position rather than anchoring to the document's top-left corner as it scales.
  const dx = fitX + clip.x - (dw - fitW) / 2;
  const dy = fitY + clip.y - (dh - fitH) / 2;
  return { dx, dy, dw, dh };
}
