import type { Point } from "./types";

function mixPixel(pixels: Uint8ClampedArray, target: number, source: Uint8ClampedArray, sourceIndex: number, amount: number): void {
  const factor = Math.max(0, Math.min(1, amount));
  for (let channel = 0; channel < 4; channel += 1) pixels[target + channel] = Math.round(pixels[target + channel]! * (1 - factor) + source[sourceIndex + channel]! * factor);
}

/**
 * Distance-based coverage of a brush shape, softened by `hardness` the same
 * way `drawDab` in paint.ts does: full coverage out to `hardness` of the
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

function applyDodgeBurnPixel(pixels: Uint8ClampedArray, index: number, amount: number, mode: "dodge" | "burn", range: DodgeBurnRange): void {
  const luminance = 0.299 * pixels[index]! + 0.587 * pixels[index + 1]! + 0.114 * pixels[index + 2]!;
  const exposure = Math.max(0, Math.min(0.92, amount * tonalWeight(luminance, range)));
  if (exposure <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    const value = pixels[index + channel]!;
    pixels[index + channel] = mode === "dodge" ? Math.min(255, value / (1 - exposure)) : Math.max(0, 255 - (255 - value) / (1 - exposure));
  }
}

/** Photoshop-style Dodge (lightens) / Burn (darkens) brush, weighted toward the chosen tonal range. */
export function dodgeBurnDab(pixels: Uint8ClampedArray, width: number, height: number, point: Point, size: number, strength: number, mode: "dodge" | "burn", range: DodgeBurnRange, selectionMask?: Uint8ClampedArray, roundness = 1, angle = 0, hardness = 0): void {
  const radius = Math.max(.5, size / 2), left = Math.max(0, Math.floor(point.x - radius)), right = Math.min(width - 1, Math.ceil(point.x + radius)), top = Math.max(0, Math.floor(point.y - radius)), bottom = Math.min(height - 1, Math.ceil(point.y + radius));
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) {
    const coverage = insideBrush(x, y, point, radius, roundness, angle, hardness); if (!coverage) continue;
    const selection = selectionMask ? selectionMask[y * width + x]! / 255 : 1; if (!selection) continue;
    applyDodgeBurnPixel(pixels, (y * width + x) * 4, strength * coverage * selection, mode, range);
  }
}

export function dodgeBurnStrokeSegment(pixels: Uint8ClampedArray, width: number, height: number, from: Point, to: Point, size: number, strength: number, mode: "dodge" | "burn", range: DodgeBurnRange, selectionMask?: Uint8ClampedArray, roundness = 1, angle = 0, hardness = 0, spacing = 0.2): void {
  // A stroke is stamped as overlapping dabs, `spacing` apart (as a fraction
  // of size) — tighter spacing overlaps more dabs over the same distance,
  // compounding the lightening/darkening more than a single pass would.
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy), steps = Math.max(1, Math.ceil(distance / Math.max(1, size * Math.max(0.02, spacing))));
  for (let step = 1; step <= steps; step += 1) { const t = step / steps; dodgeBurnDab(pixels, width, height, { x: from.x + dx * t, y: from.y + dy * t }, size, strength, mode, range, selectionMask, roundness, angle, hardness); }
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
