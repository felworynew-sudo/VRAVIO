import type { RasterRect, RgbaColor } from "./types";

export type ShapeKind = "rectangle" | "roundedRectangle" | "ellipse" | "line" | "triangle" | "polygon" | "star";

export interface ShapeSpec {
  readonly kind: ShapeKind;
  /** Bounding box the shape is fitted into; may be dragged in any direction. */
  readonly rect: RasterRect;
  readonly cornerRadius?: number;
  /** Vertex count for polygon and star. */
  readonly sides?: number;
  readonly strokeWidth?: number;
  readonly fill?: RgbaColor | null;
  readonly stroke?: RgbaColor | null;
}

type Vec = readonly [number, number];

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Distance from `p` to a rounded box centred at the origin with half-extents `half`. */
function roundedBoxDistance(px: number, py: number, halfX: number, halfY: number, radius: number): number {
  const limit = Math.max(0, Math.min(radius, Math.min(halfX, halfY)));
  const qx = Math.abs(px) - halfX + limit, qy = Math.abs(py) - halfY + limit;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - limit;
}

/** Approximate signed distance to an axis-aligned ellipse; exact enough for antialiasing. */
function ellipseDistance(px: number, py: number, radiusX: number, radiusY: number): number {
  const rx = Math.max(1e-6, radiusX), ry = Math.max(1e-6, radiusY);
  const normalized = Math.hypot(px / rx, py / ry);
  return (normalized - 1) * Math.min(rx, ry);
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay, wx = px - ax, wy = py - ay;
  const lengthSquared = ex * ex + ey * ey;
  const t = lengthSquared <= 0 ? 0 : clamp((wx * ex + wy * ey) / lengthSquared, 0, 1);
  return Math.hypot(wx - ex * t, wy - ey * t);
}

/** Signed distance to a closed polygon; negative inside. */
function polygonDistance(px: number, py: number, points: readonly Vec[]): number {
  let squared = (px - points[0]![0]) ** 2 + (py - points[0]![1]) ** 2;
  let sign = 1;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [ix, iy] = points[index]!, [jx, jy] = points[previous]!;
    const ex = jx - ix, ey = jy - iy, wx = px - ix, wy = py - iy;
    const lengthSquared = ex * ex + ey * ey;
    const t = lengthSquared <= 0 ? 0 : clamp((wx * ex + wy * ey) / lengthSquared, 0, 1);
    const bx = wx - ex * t, by = wy - ey * t;
    squared = Math.min(squared, bx * bx + by * by);
    const conditions = [py >= iy, py < jy, ex * wy > ey * wx];
    if (conditions.every(Boolean) || conditions.every((value) => !value)) sign = -sign;
  }
  return sign * Math.sqrt(squared);
}

function regularPolygonPoints(rect: RasterRect, sides: number, star: boolean): Vec[] {
  const centreX = rect.x + rect.width / 2, centreY = rect.y + rect.height / 2;
  const radiusX = rect.width / 2, radiusY = rect.height / 2;
  const count = Math.max(3, Math.round(sides)), total = star ? count * 2 : count;
  return Array.from({ length: total }, (_unused, index) => {
    const angle = -Math.PI / 2 + (index / total) * Math.PI * 2;
    const scale = star && index % 2 === 1 ? .42 : 1;
    return [centreX + Math.cos(angle) * radiusX * scale, centreY + Math.sin(angle) * radiusY * scale] as Vec;
  });
}

/** Signed distance for the shape at a document-space point; negative means inside. */
function shapeDistance(spec: ShapeSpec, x: number, y: number, cache: Vec[] | null): number {
  const { rect } = spec;
  const centreX = rect.x + rect.width / 2, centreY = rect.y + rect.height / 2;
  const localX = x - centreX, localY = y - centreY;
  if (spec.kind === "rectangle") return roundedBoxDistance(localX, localY, rect.width / 2, rect.height / 2, 0);
  if (spec.kind === "roundedRectangle") return roundedBoxDistance(localX, localY, rect.width / 2, rect.height / 2, spec.cornerRadius ?? 12);
  if (spec.kind === "ellipse") return ellipseDistance(localX, localY, rect.width / 2, rect.height / 2);
  if (spec.kind === "line") return segmentDistance(x, y, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  return polygonDistance(x, y, cache!);
}

function blendPixel(pixels: Uint8ClampedArray, index: number, color: RgbaColor, coverage: number): void {
  const sourceAlpha = clamp(coverage * (color.a / 255), 0, 1);
  if (sourceAlpha <= 0) return;
  const destinationAlpha = pixels[index + 3]! / 255;
  const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (alpha <= 0) return;
  pixels[index] = Math.round((color.r * sourceAlpha + pixels[index]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
  pixels[index + 1] = Math.round((color.g * sourceAlpha + pixels[index + 1]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
  pixels[index + 2] = Math.round((color.b * sourceAlpha + pixels[index + 2]! * destinationAlpha * (1 - sourceAlpha)) / alpha);
  pixels[index + 3] = Math.round(alpha * 255);
}

/**
 * Rasterizes a shape into an RGBA buffer.
 *
 * Coverage comes from a signed distance field rather than scanline filling, which gives fill
 * and stroke the same antialiasing for free and keeps every shape kind on one code path.
 * A line has no interior, so it is always drawn as a stroke.
 */
export function drawShape(pixels: Uint8ClampedArray, width: number, height: number, spec: ShapeSpec, selectionMask?: Uint8ClampedArray): void {
  const normalized: RasterRect = {
    x: Math.min(spec.rect.x, spec.rect.x + spec.rect.width),
    y: Math.min(spec.rect.y, spec.rect.y + spec.rect.height),
    width: Math.abs(spec.rect.width),
    height: Math.abs(spec.rect.height),
  };
  const geometry: ShapeSpec = spec.kind === "line" ? spec : { ...spec, rect: normalized };
  const strokeWidth = Math.max(0, spec.strokeWidth ?? 0);
  const lineOnly = spec.kind === "line";
  const fill = lineOnly ? null : spec.fill ?? null;
  const stroke = spec.stroke ?? (lineOnly ? spec.fill ?? null : null);
  if (!fill && (!stroke || strokeWidth <= 0)) return;

  const cache = spec.kind === "polygon" || spec.kind === "triangle" || spec.kind === "star"
    ? regularPolygonPoints(normalized, spec.kind === "triangle" ? 3 : spec.sides ?? 5, spec.kind === "star")
    : null;

  const pad = Math.ceil(strokeWidth / 2 + 2);
  const left = Math.max(0, Math.floor(Math.min(normalized.x, spec.rect.x, spec.rect.x + spec.rect.width)) - pad);
  const top = Math.max(0, Math.floor(Math.min(normalized.y, spec.rect.y, spec.rect.y + spec.rect.height)) - pad);
  const right = Math.min(width, Math.ceil(Math.max(normalized.x + normalized.width, spec.rect.x, spec.rect.x + spec.rect.width)) + pad);
  const bottom = Math.min(height, Math.ceil(Math.max(normalized.y + normalized.height, spec.rect.y, spec.rect.y + spec.rect.height)) + pad);

  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const distance = shapeDistance(geometry, x + .5, y + .5, cache);
    const fillCoverage = fill ? clamp(.5 - distance, 0, 1) : 0;
    const strokeCoverage = stroke && strokeWidth > 0 ? clamp(.5 - (Math.abs(distance) - strokeWidth / 2), 0, 1) : 0;
    if (fillCoverage <= 0 && strokeCoverage <= 0) continue;
    const pixelIndex = y * width + x;
    const selection = selectionMask ? selectionMask[pixelIndex]! / 255 : 1;
    if (selection <= 0) continue;
    const index = pixelIndex * 4;
    if (fill && fillCoverage > 0) blendPixel(pixels, index, fill, fillCoverage * selection);
    if (stroke && strokeCoverage > 0) blendPixel(pixels, index, stroke, strokeCoverage * selection);
  }
}
