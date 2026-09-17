import { selectionBounds } from "./selection";
import type { PixelSelection, Point, RasterRect } from "./types";

/**
 * Select ▸ Transform Selection: the selection's *outline* is moved, scaled and
 * rotated; no pixel of any layer changes (Photoshop's own distinction from
 * Edit ▸ Free Transform).
 *
 * The session is described the way the Move tool describes a pixel transform
 * (`PendingTransform.live`): a fixed source rectangle, the rectangle it has been
 * carried to, and an angle in degrees about that target's centre — and the mask
 * is resampled exactly once, when the session is applied. GIMP does the same
 * for a channel: its transform tools keep a matrix for the session and
 * `gimp_drawable_transform_buffer_affine` runs once on commit.
 *
 * `transformLayerPixels`/`scaleSelection`/`rotateSelection` already exist in
 * `transform.ts`, but the two selection ones are nearest-neighbour and would
 * have to be chained (scale, then rotate: two resamples of an alpha mask, the
 * compounding the Move tool's own comment measures). This is one inverse
 * mapping with bilinear sampling, so a feathered edge stays soft.
 */

export interface SelectionFrame {
  readonly source: RasterRect;
  readonly target: RasterRect;
  /** Degrees, clockwise on screen (y points down), about the target's centre. */
  readonly rotation: number;
}

/** Where a source point lands. */
export function mapFramePoint(frame: SelectionFrame, point: Point): Point {
  const { source, target } = frame;
  const sx = source.width ? target.width / source.width : 1, sy = source.height ? target.height / source.height : 1;
  const x = target.x + (point.x - source.x) * sx, y = target.y + (point.y - source.y) * sy;
  const cx = target.x + target.width / 2, cy = target.y + target.height / 2;
  const radians = frame.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  return { x: cx + (x - cx) * cos - (y - cy) * sin, y: cy + (x - cx) * sin + (y - cy) * cos };
}

/** The target rectangle's four corners after rotation: top-left, top-right, bottom-right, bottom-left. */
export function frameCorners(frame: SelectionFrame): [Point, Point, Point, Point] {
  const { source } = frame;
  return [
    mapFramePoint(frame, { x: source.x, y: source.y }),
    mapFramePoint(frame, { x: source.x + source.width, y: source.y }),
    mapFramePoint(frame, { x: source.x + source.width, y: source.y + source.height }),
    mapFramePoint(frame, { x: source.x, y: source.y + source.height }),
  ];
}

/** The axis-aligned box around the transformed frame. */
export function frameBounds(frame: SelectionFrame): RasterRect {
  const corners = frameCorners(frame);
  const xs = corners.map((corner) => corner.x), ys = corners.map((corner) => corner.y);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/** Resamples the selection mask through the frame, once. Null when nothing stays on the canvas. */
export function transformSelectionMask(selection: PixelSelection | null, width: number, height: number, frame: SelectionFrame): PixelSelection | null {
  if (!selection) return null;
  const { source, target } = frame;
  if (target.width === 0 || target.height === 0 || source.width === 0 || source.height === 0) return null;
  const mask = new Uint8ClampedArray(width * height);
  const box = frameBounds(frame);
  const cx = target.x + target.width / 2, cy = target.y + target.height / 2;
  const radians = frame.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const invX = source.width / target.width, invY = source.height / target.height;
  const src = selection.mask;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : src[y * width + x]!);
  const x0 = Math.max(0, Math.floor(box.x) - 1), x1 = Math.min(width - 1, Math.ceil(box.x + box.width) + 1);
  const y0 = Math.max(0, Math.floor(box.y) - 1), y1 = Math.min(height - 1, Math.ceil(box.y + box.height) + 1);
  for (let y = y0; y <= y1; y += 1) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx;
      // Undo the rotation, then the scale: the point in the target before turning, then in source.
      const ux = cx + dx * cos + dy * sin, uy = cy - dx * sin + dy * cos;
      const sxp = source.x + (ux - target.x) * invX - 0.5, syp = source.y + (uy - target.y) * invY - 0.5;
      if (sxp < -1 || syp < -1 || sxp > width || syp > height) continue;
      const fx = Math.floor(sxp), fy = Math.floor(syp), tx = sxp - fx, ty = syp - fy;
      const top = at(fx, fy) * (1 - tx) + at(fx + 1, fy) * tx;
      const bottom = at(fx, fy + 1) * (1 - tx) + at(fx + 1, fy + 1) * tx;
      const value = top * (1 - ty) + bottom * ty;
      if (value > 0) mask[y * width + x] = Math.round(value);
    }
  }
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}
