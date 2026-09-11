/**
 * docs/master-plan.md §37.3 item 4 — GEGL's adaptive per-thread pixel range
 * (`gegl_operation_get_pixels_per_thread`), applied to `filters.ts`'s own filter catalogue
 * rather than a new operation graph. Pure planning logic only: no Worker, no DOM — those live in
 * `apps/web/src/filter-worker-pool.ts`, which is the thing that actually dispatches what this
 * file plans (CLAUDE.md §5's engine/interface boundary).
 */

/**
 * Filters safe to split into row bands, each computed from a padded slice of the source instead
 * of the whole image, and still come out byte-identical to running the filter once over the
 * whole canvas.
 *
 * Verified against `filters.ts`'s actual dispatch (line ~267 and ~283), not assumed: every id
 * here routes either through `blur()` — a box blur that only ever reads `radius` pixels either
 * side of the pixel it is computing — or through the per-pixel branch that reads only
 * `blurred[i]` (that filter's own fixed radius-2 internal blur) or one neighbour at
 * `(x+1, y+1)` clamped to the image (radius 1). Nothing here reads from anywhere else in the
 * source, and nothing here keys off absolute width/height/position.
 *
 * Left out on purpose: `twirl`/`wave`/`pinch_bloat` (distortion relative to the *whole* canvas's
 * own centre — cropping the input would distort around the wrong centre), `vignette`
 * (distance from the whole canvas's centre), `clouds`/`glitch`/`color_halftone`/`pixelate`
 * (procedural patterns keyed by absolute pixel position — a row band would show its own pattern
 * phase, a visible seam at every band boundary), and `add_noise`/`film_grain` (seeded by
 * absolute `(x, y)` — same seam risk). Padding cannot make any of those tile-safe; they keep
 * running as one single-region request.
 */
export const PARALLEL_SAFE_FILTERS: ReadonlySet<string> = new Set([
  "box_blur", "gaussian_blur", "surface_blur", "median", "dust_and_scratches",
  "motion_blur", "radial_blur", "lens_blur", "iris_blur", "tilt_shift_blur",
  "sharpen", "unsharp_mask", "high_pass", "soft_glow",
  "edge_detect", "emboss", "glowing_edges", "plastic_wrap",
]);

/** Filters whose read radius is fixed by `filters.ts` itself rather than a user setting —
 *  `blurred = blur(source, width, height, 2)` for the first group (filters.ts:283), one clamped
 *  neighbour at `(x+1, y+1)` for the second (filters.ts:285). */
const FIXED_PADDING: Partial<Record<string, number>> = {
  sharpen: 2, unsharp_mask: 2, high_pass: 2, soft_glow: 2,
  edge_detect: 1, emboss: 1, glowing_edges: 1, plastic_wrap: 1,
};

/**
 * How many rows of padding a row band needs on each side to reproduce the whole-image result
 * exactly — mirrors `blur()`'s own `Math.max(1, Math.min(32, Math.round(radius)))` clamp
 * (filters.ts:39) for the filters that read the user's `radius` setting, so the two never
 * disagree about how far a filter actually reaches.
 */
export function paddingForFilter(id: string, settings: Record<string, number>): number {
  const fixed = FIXED_PADDING[id];
  if (fixed !== undefined) return fixed;
  const radius = settings.radius;
  return Math.max(1, Math.min(32, Math.round(Number.isFinite(radius) ? radius! : 2)));
}

export interface FilterBand { readonly startY: number; readonly endY: number; }

/**
 * Splits `height` rows into up to `maxBands` contiguous bands, never smaller than twice the
 * padding a band needs (a band thinner than its own padding would spend more work on the
 * padded margin than on the rows it actually keeps — GEGL's own reason for
 * `gegl_operation_get_pixels_per_thread` shrinking the thread count for a cheap or small
 * region rather than always maximising it). Returns a single whole-image band when the image
 * is too small to split at all.
 */
export function planFilterBands(height: number, padding: number, maxBands: number): FilterBand[] {
  const minBandHeight = Math.max(1, padding * 2);
  const bandCount = Math.max(1, Math.min(Math.max(1, maxBands), Math.floor(height / minBandHeight)));
  if (bandCount <= 1) return [{ startY: 0, endY: height }];
  const bands: FilterBand[] = [];
  for (let index = 0; index < bandCount; index += 1) {
    const startY = Math.floor((height * index) / bandCount);
    const endY = index === bandCount - 1 ? height : Math.floor((height * (index + 1)) / bandCount);
    bands.push({ startY, endY });
  }
  return bands;
}
