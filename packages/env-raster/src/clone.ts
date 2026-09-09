import type { Point } from "./types";
import { FALLOFF_STEPS, falloffTable } from "./paint";

function compositeClonePixel(
  destPixels: Uint8ClampedArray,
  destIndex: number,
  srcPixels: Uint8ClampedArray,
  srcIndex: number,
  opacity: number
): void {
  const srcAlpha = srcPixels[srcIndex + 3]! / 255;
  const dstAlpha = destPixels[destIndex + 3]! / 255;
  const effectiveAlpha = srcAlpha * opacity;
  if (effectiveAlpha <= 0) return;
  const outputAlpha = effectiveAlpha + dstAlpha * (1 - effectiveAlpha);
  if (outputAlpha <= 0) return;
  destPixels[destIndex] = Math.round((srcPixels[srcIndex]! * effectiveAlpha + destPixels[destIndex]! * dstAlpha * (1 - effectiveAlpha)) / outputAlpha);
  destPixels[destIndex + 1] = Math.round((srcPixels[srcIndex + 1]! * effectiveAlpha + destPixels[destIndex + 1]! * dstAlpha * (1 - effectiveAlpha)) / outputAlpha);
  destPixels[destIndex + 2] = Math.round((srcPixels[srcIndex + 2]! * effectiveAlpha + destPixels[destIndex + 2]! * dstAlpha * (1 - effectiveAlpha)) / outputAlpha);
  destPixels[destIndex + 3] = Math.round(outputAlpha * 255);
}

export function cloneDab(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  size: number,
  opacity: number,
  hardness = 0.82,
  selectionMask?: Uint8ClampedArray,
  roundness = 1,
  angleDegrees = 0,
  pressureSize = true,
  pressureOpacity = false,
  sourcePixels: Uint8ClampedArray = pixels
): void {
  const pressure = 1;
  const radius = Math.max(0.5, size / 2) * (pressureSize ? pressure : 1);
  const shortRadius = Math.max(0.5, radius * Math.max(0.01, Math.min(1, roundness)));
  const radians = angleDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);

  const table = falloffTable(hardness);
  const left = Math.max(0, Math.floor(targetX - radius));
  const right = Math.min(width - 1, Math.ceil(targetX + radius));
  const top = Math.max(0, Math.floor(targetY - radius));
  const bottom = Math.min(height - 1, Math.ceil(targetY + radius));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const dx = x + 0.5 - targetX;
      const dy = y + 0.5 - targetY;
      const rotatedX = (dx * cosine + dy * sine) / radius;
      const rotatedY = (-dx * sine + dy * cosine) / shortRadius;
      const squared = rotatedX * rotatedX + rotatedY * rotatedY;
      if (squared >= 1) continue;
      const distance = Math.sqrt(squared);
      // The brush's falloff, not a second copy of it. This file used to carry its own straight
      // ramp; once the brush moved to the donor's curve the two would have disagreed about what
      // "hardness 60%" means depending on which tool you picked (CLAUDE.md §4).
      const coverage = table[(distance * FALLOFF_STEPS) | 0]! * Math.min(1, (1 - distance) * radius);
      if (coverage <= 0) continue;
      const selectionAlpha = selectionMask ? selectionMask[y * width + x]! / 255 : 1;
      if (selectionAlpha <= 0) continue;

      const srcX = Math.round(sourceX + (x - targetX));
      const srcY = Math.round(sourceY + (y - targetY));
      if (srcX < 0 || srcX >= width || srcY < 0 || srcY >= height) continue;

      const destIndex = (y * width + x) * 4;
      const srcIndex = (srcY * width + srcX) * 4;
      const effectiveOpacity = Math.max(0, Math.min(1, opacity * (pressureOpacity ? pressure : 1) * coverage * selectionAlpha));

      compositeClonePixel(pixels, destIndex, sourcePixels, srcIndex, effectiveOpacity);
    }
  }
}

export function cloneStrokeSegment(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  from: Point,
  to: Point,
  sourceOffsetX: number,
  sourceOffsetY: number,
  size: number,
  opacity: number,
  selectionMask?: Uint8ClampedArray,
  hardness = 0.82,
  roundness = 1,
  angleDegrees = 0,
  pressureSize = true,
  pressureOpacity = false,
  sourcePixels: Uint8ClampedArray = pixels,
  /** Gap between dabs as a fraction of the tip, the same units the brush uses. */
  spacing = 0.18,
  /** Distance travelled since the last stamp, carried across pointer samples. */
  carry = 0,
): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(0.5, size * Math.max(0.01, spacing));
  if (!(distance > 0)) return carry;
  // Carried across pointer samples, exactly as the brush does — see
  // `drawQuadraticStrokeSegment`, which owns the explanation. This used to run
  // `for (step = 0; step <= steps)` with `steps` forced to at least one, so every pointer sample
  // stamped at its own start *and* end however close together they were: the stamp did far more
  // work than its spacing asked for, and re-stamped the same spot on every sample.
  const walk = Math.max(1, Math.ceil(distance / Math.min(step, 2)));
  let travelled = carry;
  let previousX = from.x, previousY = from.y;
  for (let index = 1; index <= walk; index += 1) {
    const t = index / walk;
    const currentX = from.x + (to.x - from.x) * t;
    const currentY = from.y + (to.y - from.y) * t;
    travelled += Math.hypot(currentX - previousX, currentY - previousY);
    previousX = currentX; previousY = currentY;
    if (travelled < step) continue;
    travelled -= step;
    cloneDab(pixels, width, height, currentX + sourceOffsetX, currentY + sourceOffsetY, currentX, currentY, size, opacity, hardness, selectionMask, roundness, angleDegrees, pressureSize, pressureOpacity, sourcePixels);
  }
  return travelled;
}
