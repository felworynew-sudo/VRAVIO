import type { Point, RasterRect } from "./types";
import { accumulateDab, accumulateStrokeSegment } from "./paint";

function mixPixel(pixels: Uint8ClampedArray, target: number, source: Uint8ClampedArray, sourceIndex: number, amount: number): void {
  const factor = Math.max(0, Math.min(1, amount));
  for (let channel = 0; channel < 4; channel += 1) pixels[target + channel] = Math.round(pixels[target + channel]! * (1 - factor) + source[sourceIndex + channel]! * factor);
}

/**
 * Distance-based coverage of a brush shape, softened by `hardness` the same
 * way `accumulateDab` in paint.ts does: full coverage out to `hardness` of the
 * radius, then a linear falloff to the edge. `hardness = 0` degenerates to
 * the old fixed `1 - distance` falloff every caller here used before the
 * option existed — the default, so a caller that does not pass it keeps
 * exactly the shape it already had.
 */
function insideBrush(x: number, y: number, point: Point, radius: number, roundness: number, angle: number, hardness = 0): number {
  const radians = angle * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians), dx = x + .5 - point.x, dy = y + .5 - point.y;
  const rx = dx * cosine + dy * sine, ry = -dx * sine + dy * cosine, distance = Math.hypot(rx / radius, ry / Math.max(.5, radius * roundness));
  if (distance > 1) return 0;
  return distance <= hardness ? 1 : 1 - (distance - hardness) / Math.max(0.0001, 1 - hardness);
}

export function blurDab(pixels: Uint8ClampedArray, source: Uint8ClampedArray, width: number, height: number, point: Point, size: number, strength: number, selectionMask?: Uint8ClampedArray, roundness = 1, angle = 0, hardness = 0): void {
  const radius = Math.max(.5, size / 2), sampleRadius = Math.max(1, Math.min(12, Math.round(size / 10))), left = Math.max(0, Math.floor(point.x - radius)), right = Math.min(width - 1, Math.ceil(point.x + radius)), top = Math.max(0, Math.floor(point.y - radius)), bottom = Math.min(height - 1, Math.ceil(point.y + radius));
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) {
    const coverage = insideBrush(x, y, point, radius, roundness, angle, hardness); if (!coverage) continue;
    const selection = selectionMask ? selectionMask[y * width + x]! / 255 : 1; if (!selection) continue;
    const sums = [0, 0, 0, 0]; let count = 0;
    for (let sy = Math.max(0, y - sampleRadius); sy <= Math.min(height - 1, y + sampleRadius); sy += 1) for (let sx = Math.max(0, x - sampleRadius); sx <= Math.min(width - 1, x + sampleRadius); sx += 1) { const index = (sy * width + sx) * 4; for (let channel = 0; channel < 4; channel += 1) sums[channel] = sums[channel]! + source[index + channel]!; count += 1; }
    const averaged = new Uint8ClampedArray(4); for (let channel = 0; channel < 4; channel += 1) averaged[channel] = Math.round(sums[channel]! / count);
    mixPixel(pixels, (y * width + x) * 4, averaged, 0, strength * coverage * selection);
  }
}

export function blurStrokeSegment(pixels: Uint8ClampedArray, source: Uint8ClampedArray, width: number, height: number, from: Point, to: Point, size: number, strength: number, selectionMask?: Uint8ClampedArray, roundness = 1, angle = 0, hardness = 0): void {
  const radius = Math.max(.5, size / 2), sampleRadius = Math.max(1, Math.min(12, Math.round(size / 10)));
  const effectLeft = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius)), effectRight = Math.min(width - 1, Math.ceil(Math.max(from.x, to.x) + radius));
  const effectTop = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius)), effectBottom = Math.min(height - 1, Math.ceil(Math.max(from.y, to.y) + radius));
  const sampleLeft = Math.max(0, effectLeft - sampleRadius), sampleRight = Math.min(width - 1, effectRight + sampleRadius), sampleTop = Math.max(0, effectTop - sampleRadius), sampleBottom = Math.min(height - 1, effectBottom + sampleRadius);
  const integralWidth = sampleRight - sampleLeft + 2, integralHeight = sampleBottom - sampleTop + 2;
  const integral = new Float64Array(integralWidth * integralHeight * 4);
  for (let y = sampleTop; y <= sampleBottom; y += 1) {
    const row = y - sampleTop + 1; const rowSums = [0, 0, 0, 0];
    for (let x = sampleLeft; x <= sampleRight; x += 1) {
      const column = x - sampleLeft + 1, sourceOffset = (y * width + x) * 4, integralOffset = (row * integralWidth + column) * 4, aboveOffset = ((row - 1) * integralWidth + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) { rowSums[channel] = rowSums[channel]! + source[sourceOffset + channel]!; integral[integralOffset + channel] = integral[aboveOffset + channel]! + rowSums[channel]!; }
    }
  }
  const dx = to.x - from.x, dy = to.y - from.y, lengthSquared = dx * dx + dy * dy;
  const average = new Uint8ClampedArray(4);
  for (let y = effectTop; y <= effectBottom; y += 1) for (let x = effectLeft; x <= effectRight; x += 1) {
    const projection = lengthSquared ? Math.max(0, Math.min(1, ((x + .5 - from.x) * dx + (y + .5 - from.y) * dy) / lengthSquared)) : 0;
    const center = { x: from.x + dx * projection, y: from.y + dy * projection }, coverage = insideBrush(x, y, center, radius, roundness, angle, hardness); if (!coverage) continue;
    const selection = selectionMask ? selectionMask[y * width + x]! / 255 : 1; if (!selection) continue;
    const x0 = Math.max(sampleLeft, x - sampleRadius) - sampleLeft, x1 = Math.min(sampleRight, x + sampleRadius) - sampleLeft + 1, y0 = Math.max(sampleTop, y - sampleRadius) - sampleTop, y1 = Math.min(sampleBottom, y + sampleRadius) - sampleTop + 1;
    const count = (x1 - x0) * (y1 - y0), topLeft = (y0 * integralWidth + x0) * 4, topRight = (y0 * integralWidth + x1) * 4, bottomLeft = (y1 * integralWidth + x0) * 4, bottomRight = (y1 * integralWidth + x1) * 4;
    for (let channel = 0; channel < 4; channel += 1) average[channel] = Math.round((integral[bottomRight + channel]! - integral[topRight + channel]! - integral[bottomLeft + channel]! + integral[topLeft + channel]!) / count);
    mixPixel(pixels, (y * width + x) * 4, average, 0, strength * coverage * selection);
  }
}

export type DodgeBurnRange = "shadows" | "midtones" | "highlights";

function tonalWeight(luminance: number, range: DodgeBurnRange): number {
  const t = luminance / 255;
  if (range === "shadows") return Math.max(0, 1 - t / 0.5);
  if (range === "highlights") return Math.max(0, (t - 0.5) / 0.5);
  return 1 - Math.abs(t - 0.5) * 2;
}

/**
 * The Dodge/Burn tonal transform for one pixel, reading `source` fresh and
 * writing into `output` — never mutates its input, unlike the version this
 * replaced. That was the actual bug an owner reported (dragging Burn over a
 * face burns everything to solid black almost at once): the old
 * `applyDodgeBurnPixel` mutated `pixels` in place and was called once per
 * overlapping dab along a stroke, each call reading the *previous* dab's
 * already-darkened output — `255 - (255-value)/(1-exposure)` applied
 * repeatedly to its own result converges toward 0 fast, and a stroke's dabs
 * overlap heavily at the default 12% spacing.
 *
 * GIMP's own Dodge/Burn (`app/paint/gimpdodgeburn.c`,
 * `gimp_paint_core_get_orig_image`) and Photoshop's documented Airbrush
 * behaviour ("the adjustment builds up gradually... until it reaches the
 * value set by the Exposure slider") both work the other way: every dab in
 * one stroke computes its effect against the *same* frozen pre-stroke
 * pixel, and how much of that computed effect shows through builds up
 * through accumulated brush coverage — capped at Exposure, never past it,
 * exactly the way `paint.ts`'s `accumulateDab` already caps a normal
 * brush's overlapping dabs at its Opacity. `dodgeBurnDab`/
 * `dodgeBurnStrokeSegment` below now accumulate coverage the identical way
 * instead of reimplementing that cap; `compositeDodgeBurn` is what actually
 * calls this function, once per pixel, from the stroke's own frozen source.
 */
function dodgeBurnTransform(source: Uint8ClampedArray, output: Uint8ClampedArray, index: number, amount: number, mode: "dodge" | "burn", range: DodgeBurnRange): void {
  const luminance = 0.299 * source[index]! + 0.587 * source[index + 1]! + 0.114 * source[index + 2]!;
  const exposure = Math.max(0, Math.min(0.92, amount * tonalWeight(luminance, range)));
  if (exposure <= 0) { output[index] = source[index]!; output[index + 1] = source[index + 1]!; output[index + 2] = source[index + 2]!; return; }
  for (let channel = 0; channel < 3; channel += 1) {
    const value = source[index + channel]!;
    output[index + channel] = Math.round(mode === "dodge" ? Math.min(255, value / (1 - exposure)) : Math.max(0, 255 - (255 - value) / (1 - exposure)));
  }
}

/** Accumulates one dab's brush-shaped coverage toward `exposure` as a ceiling
 * — `accumulateDab` from paint.ts, the identical mechanism a normal brush
 * uses to cap overlapping dabs at its own Opacity, reused rather than
 * reimplemented. `flow` is fixed at 1: Dodge/Burn has no separate Flow
 * control of its own, only Exposure, so a dab reaches the ceiling as soon
 * as it touches a pixel at full brush-shape coverage — only the soft
 * falloff toward a dab's own edge still needs several overlapping dabs to
 * reach it, the same as a hard-edged normal brush stroke would. */
export function dodgeBurnDab(coverage: Uint8ClampedArray, width: number, height: number, point: Point, size: number, exposure: number, selectionMask?: Uint8ClampedArray, roundness = 1, angle = 0, hardness = 0): void {
  accumulateDab(coverage, width, height, point, size, 1, exposure, hardness, selectionMask, roundness, angle, false, false);
}

/** Same walk `accumulateStrokeSegment` already does for a normal brush —
 * `dodgeBurnStrokeSegment`'s own callers (`tonal-stroke.ts`) draw a straight
 * segment, not paint-stroke's midpoint-smoothed curve, so the control point
 * passed here is the segment's own midpoint: a quadratic Bézier degenerates
 * to a straight line exactly when its control point is the midpoint of its
 * two ends. */
export function dodgeBurnStrokeSegment(coverage: Uint8ClampedArray, width: number, height: number, from: Point, to: Point, size: number, exposure: number, selectionMask?: Uint8ClampedArray, roundness = 1, angle = 0, hardness = 0, spacing = 0.2, carry = 0): number {
  const control: Point = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, pressure: ((from.pressure ?? 1) + (to.pressure ?? 1)) / 2 };
  return accumulateStrokeSegment(coverage, width, height, from, control, to, size, 1, exposure, selectionMask, hardness, spacing, roundness, angle, false, false, carry);
}

/**
 * Lays a stroke's accumulated Dodge/Burn coverage onto the picture, once,
 * over the rectangle it covers — `compositeCoverage`'s own sibling for a
 * computed tonal transform instead of a flat paint colour. `base` is the
 * stroke's frozen "before this stroke" snapshot and is only ever read, so a
 * frame may recomposite the same band as often as it likes without the
 * stroke building on itself — the property the whole coverage mechanism
 * exists for, same as `compositeCoverage`'s own doc comment says.
 */
export function compositeDodgeBurn(output: Uint8ClampedArray, base: Uint8ClampedArray, coverage: Uint8ClampedArray, width: number, height: number, region: RasterRect, mode: "dodge" | "burn", range: DodgeBurnRange): void {
  const left = Math.max(0, Math.floor(region.x)), top = Math.max(0, Math.floor(region.y));
  const right = Math.min(width, Math.ceil(region.x + region.width)), bottom = Math.min(height, Math.ceil(region.y + region.height));
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const index = y * width + x, pixel = index * 4, amount = coverage[index]! / 255;
    if (amount <= 0) { output[pixel] = base[pixel]!; output[pixel + 1] = base[pixel + 1]!; output[pixel + 2] = base[pixel + 2]!; output[pixel + 3] = base[pixel + 3]!; continue; }
    dodgeBurnTransform(base, output, pixel, amount, mode, range);
    output[pixel + 3] = base[pixel + 3]!;
  }
}

export function smudgeStrokeSegment(pixels: Uint8ClampedArray, source: Uint8ClampedArray, width: number, height: number, from: Point, to: Point, size: number, strength: number, selectionMask?: Uint8ClampedArray, roundness = 1, angle = 0, hardness = 0, spacing = 0.14): void {
  // Same overlapping-dabs-`spacing`-apart shape as dodge/burn's stroke —
  // tighter spacing drags more, smoother trail; wider spacing leaves visible
  // gaps between the samples it drags forward.
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy), steps = Math.max(1, Math.ceil(distance / Math.max(1, size * Math.max(0.02, spacing)))), radius = Math.max(.5, size / 2);
  for (let step = 1; step <= steps; step += 1) { const t = step / steps, point = { x: from.x + dx * t, y: from.y + dy * t }, sourcePoint = { x: point.x - dx / steps, y: point.y - dy / steps }, left = Math.max(0, Math.floor(point.x - radius)), right = Math.min(width - 1, Math.ceil(point.x + radius)), top = Math.max(0, Math.floor(point.y - radius)), bottom = Math.min(height - 1, Math.ceil(point.y + radius));
    const smearSource = step === 1 ? source : pixels;
    for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) { const coverage = insideBrush(x, y, point, radius, roundness, angle, hardness); if (!coverage) continue; const selection = selectionMask ? selectionMask[y * width + x]! / 255 : 1; if (!selection) continue; const sx = Math.max(0, Math.min(width - 1, Math.round(sourcePoint.x + x - point.x))), sy = Math.max(0, Math.min(height - 1, Math.round(sourcePoint.y + y - point.y))); mixPixel(pixels, (y * width + x) * 4, smearSource, (sy * width + sx) * 4, strength * coverage * selection); }
  }
}
