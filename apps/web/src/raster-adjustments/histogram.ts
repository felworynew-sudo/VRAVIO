export function luminanceHistogram(pixels: Uint8ClampedArray, bins = 64): number[] {
  const result = Array.from({ length: bins }, () => 0);
  for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3]) { const value = Math.round(pixels[index]! * .2126 + pixels[index + 1]! * .7152 + pixels[index + 2]! * .0722); result[Math.min(bins - 1, Math.floor(value / 256 * bins))]! += 1; }
  return result;
}
