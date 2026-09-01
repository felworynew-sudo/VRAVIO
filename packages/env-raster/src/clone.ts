import type { Point } from "./types";

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

  const left = Math.max(0, Math.floor(targetX - radius));
  const right = Math.min(width - 1, Math.ceil(targetX + radius));
  const top = Math.max(0, Math.floor(targetY - radius));
  const bottom = Math.min(height - 1, Math.ceil(targetY + radius));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const dx = x + 0.5 - targetX;
      const dy = y + 0.5 - targetY;
      const rotatedX = dx * cosine + dy * sine;
      const rotatedY = -dx * sine + dy * cosine;
      const distance = Math.hypot(rotatedX / radius, rotatedY / shortRadius);
      if (distance > 1) continue;

      const coverage = distance <= hardness ? 1 : 1 - (distance - hardness) / Math.max(0.0001, 1 - hardness);
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
  sourcePixels: Uint8ClampedArray = pixels
): void {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, size * 0.18)));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const currentX = from.x + (to.x - from.x) * t;
    const currentY = from.y + (to.y - from.y) * t;
    const sourceX = currentX + sourceOffsetX;
    const sourceY = currentY + sourceOffsetY;
    cloneDab(pixels, width, height, sourceX, sourceY, currentX, currentY, size, opacity, hardness, selectionMask, roundness, angleDegrees, pressureSize, pressureOpacity, sourcePixels);
  }
}
