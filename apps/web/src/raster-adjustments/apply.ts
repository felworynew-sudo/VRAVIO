import { applyAdjustment, confineToSelection, type PixelSelection, type RasterAdjustment } from "@vravio/env-raster";

/** Computes a destructive adjustment without mutating its source. */
export function adjustedPixels(source: Uint8ClampedArray, adjustment: RasterAdjustment, selection: PixelSelection | null): Uint8ClampedArray {
  const result = source.slice();
  applyAdjustment(result, adjustment);
  return selection ? confineToSelection(source, result, selection.mask) : result;
}
