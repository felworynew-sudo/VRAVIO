/**
 * Indexed colour: building a palette for an image, and snapping pixels onto one
 * (docs/master-plan.md §59.3).
 *
 * Median cut, the algorithm Heckbert published in 1982 and the one GIMP's `median-cut` and every
 * GIF encoder still use: put every colour in one box, repeatedly split the box with the widest
 * channel range at its median, and take each final box's average. It beats a fixed colour cube
 * badly on real photographs — a sunset gets its oranges rather than a share of the whole cube —
 * and it is what "Indexed Color" means in practice.
 *
 * Dithering is Floyd–Steinberg, the same error diffusion `exportImage.ts` uses for its own colour
 * reduction; the two are separate because that one reduces a finished export and this one changes
 * the document itself.
 */

export interface IndexedPalette {
  /** Palette entries as RGB triples, packed — three bytes per colour. */
  readonly colors: Uint8ClampedArray;
  readonly size: number;
}

interface Box {
  readonly pixels: number[];       // indices into the sample array
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

const boxOf = (pixels: number[], samples: Uint8ClampedArray): Box => {
  const min: [number, number, number] = [255, 255, 255], max: [number, number, number] = [0, 0, 0];
  for (const pixel of pixels) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = samples[pixel * 3 + channel]!;
      if (value < min[channel]!) min[channel] = value;
      if (value > max[channel]!) max[channel] = value;
    }
  }
  return { pixels, min, max };
};

/**
 * A palette of at most `size` colours for an RGBA buffer.
 *
 * Fully transparent pixels take no part: they carry no colour anyone will see, and letting them
 * vote pulls every palette toward black. Opaque pixels are sampled on a stride when the image is
 * large — median cut on ten million pixels costs minutes and answers the same question as one on
 * sixty thousand.
 */
export function buildIndexedPalette(pixels: Uint8ClampedArray, size = 256): IndexedPalette {
  const wanted = Math.max(2, Math.min(256, Math.round(size)));
  const pixelCount = pixels.length / 4;
  const stride = Math.max(1, Math.floor(pixelCount / 60000));
  const samples: number[] = [];
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    if (!pixels[pixel * 4 + 3]) continue;
    samples.push(pixels[pixel * 4]!, pixels[pixel * 4 + 1]!, pixels[pixel * 4 + 2]!);
  }
  if (!samples.length) return { colors: new Uint8ClampedArray([0, 0, 0]), size: 1 };
  const sampleArray = new Uint8ClampedArray(samples);
  const count = sampleArray.length / 3;

  let boxes: Box[] = [boxOf(Array.from({ length: count }, (_, index) => index), sampleArray)];
  while (boxes.length < wanted) {
    // Split the box with the widest single-channel spread: the one contributing most of the error.
    let target = -1, widest = 0, axis = 0;
    boxes.forEach((box, index) => {
      if (box.pixels.length < 2) return;
      for (let channel = 0; channel < 3; channel += 1) {
        const spread = box.max[channel]! - box.min[channel]!;
        if (spread > widest) { widest = spread; target = index; axis = channel; }
      }
    });
    if (target < 0 || widest === 0) break;
    const box = boxes[target]!;
    const sorted = [...box.pixels].sort((a, b) => sampleArray[a * 3 + axis]! - sampleArray[b * 3 + axis]!);
    const middle = Math.floor(sorted.length / 2);
    boxes = [...boxes.slice(0, target), boxOf(sorted.slice(0, middle), sampleArray), boxOf(sorted.slice(middle), sampleArray), ...boxes.slice(target + 1)];
  }

  const colors = new Uint8ClampedArray(boxes.length * 3);
  boxes.forEach((box, index) => {
    let r = 0, g = 0, b = 0;
    for (const pixel of box.pixels) { r += sampleArray[pixel * 3]!; g += sampleArray[pixel * 3 + 1]!; b += sampleArray[pixel * 3 + 2]!; }
    const total = Math.max(1, box.pixels.length);
    colors[index * 3] = Math.round(r / total); colors[index * 3 + 1] = Math.round(g / total); colors[index * 3 + 2] = Math.round(b / total);
  });
  return { colors, size: boxes.length };
}

/** The palette entry nearest a colour, by squared distance in RGB — what "snap to the palette"
 *  means, and the inner loop of everything below. */
export function nearestPaletteIndex(palette: IndexedPalette, r: number, g: number, b: number): number {
  let best = 0, bestDistance = Infinity;
  for (let index = 0; index < palette.size; index += 1) {
    const dr = r - palette.colors[index * 3]!, dg = g - palette.colors[index * 3 + 1]!, db = b - palette.colors[index * 3 + 2]!;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  }
  return best;
}

/**
 * Rewrites an RGBA buffer so every pixel is one of the palette's colours, in place.
 *
 * With `dither`, the quantisation error is diffused Floyd–Steinberg style, which is what keeps a
 * gradient from banding into stripes at 32 colours. Alpha is untouched: indexed colour is about
 * colour, and a transparent pixel has none.
 */
export function snapToPalette(pixels: Uint8ClampedArray, width: number, height: number, palette: IndexedPalette, dither = false): void {
  const error = dither ? new Float32Array(width * height * 3) : null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x, index = pixel * 4;
      if (!pixels[index + 3]) continue;
      const r = pixels[index]! + (error?.[pixel * 3] ?? 0);
      const g = pixels[index + 1]! + (error?.[pixel * 3 + 1] ?? 0);
      const b = pixels[index + 2]! + (error?.[pixel * 3 + 2] ?? 0);
      const entry = nearestPaletteIndex(palette, r, g, b);
      const nr = palette.colors[entry * 3]!, ng = palette.colors[entry * 3 + 1]!, nb = palette.colors[entry * 3 + 2]!;
      pixels[index] = nr; pixels[index + 1] = ng; pixels[index + 2] = nb;
      if (!error) continue;
      const differences = [r - nr, g - ng, b - nb];
      const spread = (targetPixel: number, weight: number) => {
        for (let channel = 0; channel < 3; channel += 1) error[targetPixel * 3 + channel]! += differences[channel]! * weight;
      };
      if (x + 1 < width) spread(pixel + 1, 7 / 16);
      if (y + 1 < height) {
        if (x > 0) spread(pixel + width - 1, 3 / 16);
        spread(pixel + width, 5 / 16);
        if (x + 1 < width) spread(pixel + width + 1, 1 / 16);
      }
    }
  }
}

/** A palette as hex strings, which is what a document stores and a colour-table dialog shows. */
export const paletteToHex = (palette: IndexedPalette): string[] =>
  Array.from({ length: palette.size }, (_, index) =>
    `#${[0, 1, 2].map((channel) => palette.colors[index * 3 + channel]!.toString(16).padStart(2, "0")).join("")}`);

export const paletteFromHex = (colors: readonly string[]): IndexedPalette => {
  const bytes = new Uint8ClampedArray(colors.length * 3);
  colors.forEach((color, index) => {
    const value = Number.parseInt(color.replace("#", ""), 16);
    bytes[index * 3] = (value >> 16) & 0xff; bytes[index * 3 + 1] = (value >> 8) & 0xff; bytes[index * 3 + 2] = value & 0xff;
  });
  return { colors: bytes, size: colors.length };
};
