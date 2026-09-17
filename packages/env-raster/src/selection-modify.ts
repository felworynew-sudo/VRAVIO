import { selectionBounds } from "./selection";
import type { PixelSelection, RasterRect } from "./types";

/**
 * Select ▸ Modify ▸ Expand / Contract / Smooth (Photoshop's names).
 *
 * Donor for the code: GIMP. `gimp_channel_grow`/`gimp_channel_shrink`
 * (app/core/gimpchannel.c) run `gimp:grow`/`gimp:shrink`
 * (app/operations/gimpoperationgrow.c, gimpoperationshrink.c): a maximum
 * (grow) or minimum (shrink) over an *elliptical* structuring element whose
 * half-height at each column offset comes from a lookup table
 * (`compute_border`: `circ[i] = RINT(yradius/xradius * sqrt(xradius² - tmp²))`),
 * evaluated row by row against per-column extremes over a vertical window.
 * The same shape is used here, with one radius for both axes — Photoshop's
 * dialogs take a single pixel amount.
 *
 * GIMP's shrink has `edge_lock`: whether pixels past the image edge count as
 * selected. Photoshop exposes the inverse as "Apply effect at canvas bounds";
 * unchecked (its default), a selection touching the canvas edge does not pull
 * away from it. That is `applyAtCanvasBounds = false` here: out-of-canvas
 * samples repeat the edge pixel, as GIMP's edge-lock padding does.
 *
 * GIMP has no Smooth. Photoshop's Smooth removes stray specks and rounds
 * corners with a "sample radius": the classic reading is a median over the
 * neighbourhood (for a hard mask, a majority vote). Implemented as a median
 * over the same disc, with a sliding 256-bin histogram (Huang's algorithm)
 * so moving one pixel costs O(radius), not O(radius²).
 *
 * Work is confined to the selection's bounds (plus the radius where the
 * result can reach past them), and every function returns a new selection —
 * or null when nothing is left, the same contract as `featherSelection`.
 */

/** Half-height of the disc at each column offset -r..r (GIMP's `compute_border`). */
function discHalfHeights(radius: number): Int32Array {
  const heights = new Int32Array(radius * 2 + 1);
  for (let i = 0; i <= radius * 2; i += 1) {
    const dx = i - radius;
    heights[i] = Math.round(Math.sqrt(Math.max(0, radius * radius - dx * dx)));
  }
  return heights;
}

const clampRect = (x0: number, y0: number, x1: number, y1: number, width: number, height: number) => ({
  x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(width - 1, x1), y1: Math.min(height - 1, y1),
});

function finish(mask: Uint8ClampedArray, width: number, height: number): PixelSelection | null {
  const bounds: RasterRect = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

/**
 * The mask with a `pad`-pixel border around it, so the inner loops index a
 * plain array instead of bounds-checking every sample. The border holds
 * `outside`, or repeats the nearest edge pixel when `outside` is null
 * (GIMP's edge-lock padding: "pixels outside the region are identical to the
 * edge pixels").
 */
function padded(source: Uint8ClampedArray, width: number, height: number, pad: number, outside: number | null): { data: Uint8Array; stride: number } {
  const stride = width + pad * 2, rows = height + pad * 2;
  const data = new Uint8Array(stride * rows);
  if (outside !== null && outside !== 0) data.fill(outside);
  for (let y = -pad; y < height + pad; y += 1) {
    const inside = y >= 0 && y < height;
    if (!inside && outside !== null) continue;
    const sy = Math.min(height - 1, Math.max(0, y));
    const target = (y + pad) * stride;
    data.set(source.subarray(sy * width, sy * width + width), target + pad);
    if (outside === null) {
      data.fill(source[sy * width]!, target, target + pad);
      data.fill(source[sy * width + width - 1]!, target + pad + width, target + stride);
    }
  }
  return { data, stride };
}

/**
 * Max (grow) or min (shrink) over the disc, for the pixels in `region`.
 * Per output row: the extreme of each column over rows y-h..y+h for every
 * h ≤ radius, then for each pixel the extreme over the disc's column
 * segments (GIMP's `max[x][circ[i]]`). Saturation short-circuits both steps —
 * on a hard-edged mask most pixels reach 255 (grow) or 0 (shrink) at once.
 */
function morphology(
  source: Uint8ClampedArray, width: number, height: number, radius: number,
  grow: boolean, outside: number | null, region: { x0: number; y0: number; x1: number; y1: number },
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  if (region.x1 < region.x0 || region.y1 < region.y0) return output;
  const heights = discHalfHeights(radius);
  const { data, stride } = padded(source, width, height, radius, outside);
  const saturated = grow ? 255 : 0;
  const cx0 = region.x0 - radius, span = region.x1 - region.x0 + 1 + radius * 2;
  // extreme[h * span + c]: max/min over rows y-h..y+h of column cx0+c.
  const extreme = new Uint8Array((radius + 1) * span);
  for (let y = region.y0; y <= region.y1; y += 1) {
    const centre = (y + radius) * stride;
    for (let c = 0; c < span; c += 1) {
      const column = cx0 + c + radius;
      let value = data[centre + column]!, h = 0;
      extreme[c] = value;
      for (h = 1; h <= radius && value !== saturated; h += 1) {
        const above = data[centre - h * stride + column]!, below = data[centre + h * stride + column]!;
        if (grow) { if (above > value) value = above; if (below > value) value = below; }
        else { if (above < value) value = above; if (below < value) value = below; }
        extreme[h * span + c] = value;
      }
      for (; h <= radius; h += 1) extreme[h * span + c] = value;
    }
    const row = y * width;
    for (let x = region.x0; x <= region.x1; x += 1) {
      const c = x - cx0;
      if (extreme[c] === saturated) { output[row + x] = saturated; continue; }
      let value = grow ? 0 : 255;
      for (let i = 0; i <= radius * 2; i += 1) {
        const v = extreme[heights[i]! * span + c + i - radius]!;
        if (grow ? v > value : v < value) { value = v; if (value === saturated) break; }
      }
      output[row + x] = value;
    }
  }
  return output;
}

/** Select ▸ Modify ▸ Expand. */
export function expandSelection(selection: PixelSelection | null, width: number, height: number, radius: number): PixelSelection | null {
  if (!selection) return null;
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return { mask: selection.mask.slice(), bounds: { ...selection.bounds } };
  const { x, y, width: w, height: h } = selection.bounds;
  const region = clampRect(x - r, y - r, x + w - 1 + r, y + h - 1 + r, width, height);
  return finish(morphology(selection.mask, width, height, r, true, 0, region), width, height);
}

/** Select ▸ Modify ▸ Contract. */
export function contractSelection(
  selection: PixelSelection | null, width: number, height: number, radius: number, applyAtCanvasBounds = false,
): PixelSelection | null {
  if (!selection) return null;
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return { mask: selection.mask.slice(), bounds: { ...selection.bounds } };
  const { x, y, width: w, height: h } = selection.bounds;
  // A minimum can only lose pixels, so nothing outside the bounds can appear.
  const region = clampRect(x, y, x + w - 1, y + h - 1, width, height);
  return finish(morphology(selection.mask, width, height, r, false, applyAtCanvasBounds ? 0 : null, region), width, height);
}

/** Select ▸ Modify ▸ Smooth: median over a disc of `radius`. */
export function smoothSelection(
  selection: PixelSelection | null, width: number, height: number, radius: number, applyAtCanvasBounds = false,
): PixelSelection | null {
  if (!selection) return null;
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return { mask: selection.mask.slice(), bounds: { ...selection.bounds } };
  const source = selection.mask, output = new Uint8ClampedArray(source.length);
  const { x: bx, y: by, width: bw, height: bh } = selection.bounds;
  const region = clampRect(bx - r, by - r, bx + bw - 1 + r, by + bh - 1 + r, width, height);
  const heights = discHalfHeights(r);
  // Half-width of the disc at each row offset -r..r (the disc is symmetric).
  const halfWidths = heights;
  const pad = r + 1;
  const { data, stride } = padded(source, width, height, pad, applyAtCanvasBounds ? 0 : null);
  let area = 0;
  for (let j = 0; j <= r * 2; j += 1) area += halfWidths[j]! * 2 + 1;
  const half = area >> 1; // the median is the (half+1)-th smallest sample
  const histogram = new Int32Array(256);

  for (let y = region.y0; y <= region.y1; y += 1) {
    histogram.fill(0);
    const x0 = region.x0;
    for (let j = -r; j <= r; j += 1) {
      const hw = halfWidths[j + r]!;
      const base = (y + j + pad) * stride + pad + x0;
      for (let dx = -hw; dx <= hw; dx += 1) histogram[data[base + dx]!]! += 1;
    }
    // Running median: `median` with `below` = count of samples < median.
    let median = 0, below = 0;
    while (below + histogram[median]! <= half) { below += histogram[median]!; median += 1; }
    const row = y * width;
    for (let x = x0; ; x += 1) {
      output[row + x] = median;
      if (x === region.x1) break;
      // Rows are walked by index; the left edge of row j sits at
      // rowStart[j] + x - hw, its new right edge one past x + hw.
      for (let j = 0; j <= r * 2; j += 1) {
        const hw = halfWidths[j]!, base = (y + j - r + pad) * stride + pad + x;
        const leaving = data[base - hw]!, entering = data[base + 1 + hw]!;
        if (leaving === entering) continue;
        histogram[leaving]! -= 1; if (leaving < median) below -= 1;
        histogram[entering]! += 1; if (entering < median) below += 1;
      }
      while (below > half) { median -= 1; below -= histogram[median]!; }
      while (below + histogram[median]! <= half) { below += histogram[median]!; median += 1; }
    }
  }
  return finish(output, width, height);
}
