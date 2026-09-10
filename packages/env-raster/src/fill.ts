import type { PixelSelection, RgbaColor } from "./types";

function withinTolerance(pixels: Uint8ClampedArray, index: number, target: RgbaColor, tolerance: number): boolean {
  return Math.max(Math.abs(pixels[index]! - target.r), Math.abs(pixels[index + 1]! - target.g), Math.abs(pixels[index + 2]! - target.b), Math.abs(pixels[index + 3]! - target.a)) <= tolerance;
}

export function floodFill(pixels: Uint8ClampedArray, width: number, height: number, startX: number, startY: number, replacement: RgbaColor, tolerance = 0, selectionMask?: Uint8ClampedArray): number {
  const x = Math.floor(startX), y = Math.floor(startY);
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  if (selectionMask?.[y * width + x] === 0) return 0;
  const start = (y * width + x) * 4;
  const target = { r: pixels[start]!, g: pixels[start + 1]!, b: pixels[start + 2]!, a: pixels[start + 3]! };
  if (withinTolerance(new Uint8ClampedArray([replacement.r, replacement.g, replacement.b, replacement.a]), 0, target, 0)) return 0;
  const visited = new Uint8Array(width * height);
  const stack = [y * width + x];
  let changed = 0;
  while (stack.length) {
    const position = stack.pop()!;
    if (visited[position]) continue;
    visited[position] = 1;
    const index = position * 4;
    if (!withinTolerance(pixels, index, target, tolerance)) continue;
    const selectionAlpha = selectionMask ? selectionMask[position]! / 255 : 1;
    if (selectionAlpha <= 0) continue;
    pixels[index] = Math.round(pixels[index]! + (replacement.r - pixels[index]!) * selectionAlpha);
    pixels[index + 1] = Math.round(pixels[index + 1]! + (replacement.g - pixels[index + 1]!) * selectionAlpha);
    pixels[index + 2] = Math.round(pixels[index + 2]! + (replacement.b - pixels[index + 2]!) * selectionAlpha);
    pixels[index + 3] = Math.round(pixels[index + 3]! + (replacement.a - pixels[index + 3]!) * selectionAlpha);
    changed += 1;
    const px = position % width, py = Math.floor(position / width);
    if (px > 0) stack.push(position - 1); if (px + 1 < width) stack.push(position + 1);
    if (py > 0) stack.push(position - width); if (py + 1 < height) stack.push(position + width);
  }
  return changed;
}

/**
 * A solid-color fill over a selection (or the whole layer, with none active)
 * — Photoshop's Alt+Backspace/Ctrl+Backspace (Foreground/Background) and the
 * Fill dialog's own "Contents" + opacity, all three built on the one
 * operation. Blends toward `color` per channel by coverage, the same
 * per-channel lerp `floodFill` above already uses for its own selection
 * mask, rather than a second, differently-rounded piece of arithmetic for
 * what is the same "paint this color here, this much" question.
 *
 * `opacity` (0–1) scales the coverage uniformly, which is what the Fill
 * dialog's own opacity slider does in Photoshop — a fill at 50% opacity over
 * an already-opaque pixel lands the color half-way, not at half the alpha.
 */
export function fillSelectedPixels(
  pixels: Uint8ClampedArray, width: number, height: number,
  selection: PixelSelection | null, color: RgbaColor, opacity = 1,
): Uint8ClampedArray {
  const result = pixels.slice();
  const strength = Math.max(0, Math.min(1, opacity));
  if (strength <= 0) return result;
  for (let index = 0; index < width * height; index += 1) {
    const coverage = (selection ? selection.mask[index]! / 255 : 1) * strength;
    if (coverage <= 0) continue;
    const at = index * 4;
    result[at] = Math.round(result[at]! + (color.r - result[at]!) * coverage);
    result[at + 1] = Math.round(result[at + 1]! + (color.g - result[at + 1]!) * coverage);
    result[at + 2] = Math.round(result[at + 2]! + (color.b - result[at + 2]!) * coverage);
    result[at + 3] = Math.round(result[at + 3]! + (color.a - result[at + 3]!) * coverage);
  }
  return result;
}
