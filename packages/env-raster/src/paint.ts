import type { Point, RgbaColor } from "./types";

function compositePixel(pixels: Uint8ClampedArray, index: number, color: RgbaColor, alpha: number, erase: boolean): void {
  const destinationAlpha = pixels[index + 3]! / 255;
  if (erase) {
    pixels[index + 3] = Math.round(destinationAlpha * (1 - alpha) * 255);
    return;
  }
  const sourceAlpha = (color.a / 255) * alpha;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  pixels[index] = Math.round((color.r * sourceAlpha + pixels[index]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 1] = Math.round((color.g * sourceAlpha + pixels[index + 1]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 2] = Math.round((color.b * sourceAlpha + pixels[index + 2]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 3] = Math.round(outputAlpha * 255);
}

export function drawDab(pixels: Uint8ClampedArray, width: number, height: number, point: Point, size: number, color: RgbaColor, opacity: number, erase = false, hardness = 0.82, selectionMask?: Uint8ClampedArray, roundness = 1, angleDegrees = 0, pressureSize = true, pressureOpacity = false): void {
  const pressure = Math.max(0.05, point.pressure ?? 1);
  const radius = Math.max(0.5, size / 2) * (pressureSize ? pressure : 1);
  const shortRadius = Math.max(0.5, radius * Math.max(0.01, Math.min(1, roundness)));
  const radians = angleDegrees * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const left = Math.max(0, Math.floor(point.x - radius));
  const right = Math.min(width - 1, Math.ceil(point.x + radius));
  const top = Math.max(0, Math.floor(point.y - radius));
  const bottom = Math.min(height - 1, Math.ceil(point.y + radius));
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) {
    const dx = x + 0.5 - point.x, dy = y + 0.5 - point.y;
    const rotatedX = dx * cosine + dy * sine, rotatedY = -dx * sine + dy * cosine;
    const distance = Math.hypot(rotatedX / radius, rotatedY / shortRadius);
    if (distance > 1) continue;
    const coverage = distance <= hardness ? 1 : 1 - (distance - hardness) / Math.max(0.0001, 1 - hardness);
    const selectionAlpha = selectionMask ? selectionMask[y * width + x]! / 255 : 1;
    if (selectionAlpha <= 0) continue;
    compositePixel(pixels, (y * width + x) * 4, color, Math.max(0, Math.min(1, opacity * (pressureOpacity ? pressure : 1) * coverage * selectionAlpha)), erase);
  }
}

export function drawStrokeSegment(pixels: Uint8ClampedArray, width: number, height: number, from: Point, to: Point, size: number, color: RgbaColor, opacity: number, erase = false, selectionMask?: Uint8ClampedArray): void {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, size * 0.18)));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    drawDab(pixels, width, height, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, pressure: (from.pressure ?? 1) + ((to.pressure ?? 1) - (from.pressure ?? 1)) * t }, size, color, opacity, erase, 0.82, selectionMask);
  }
}

/** Resamples a quadratic pointer path into evenly spaced brush dabs. */
export function drawQuadraticStrokeSegment(pixels: Uint8ClampedArray, width: number, height: number, from: Point, control: Point, to: Point, size: number, color: RgbaColor, opacity: number, erase = false, selectionMask?: Uint8ClampedArray, hardness = 0.82, spacing = 0.12, roundness = 1, angleDegrees = 0, pressureSize = true, pressureOpacity = false): void {
  const approximateLength = Math.hypot(control.x - from.x, control.y - from.y) + Math.hypot(to.x - control.x, to.y - control.y);
  const steps = Math.max(1, Math.ceil(approximateLength / Math.max(0.5, size * Math.max(0.01, spacing))));
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps, inverse = 1 - t;
    drawDab(pixels, width, height, {
      x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
      y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
      pressure: inverse * inverse * (from.pressure ?? 1) + 2 * inverse * t * (control.pressure ?? 1) + t * t * (to.pressure ?? 1),
    }, size, color, opacity, erase, hardness, selectionMask, roundness, angleDegrees, pressureSize, pressureOpacity);
  }
}
