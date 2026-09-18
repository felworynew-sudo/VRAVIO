/**
 * Pixel formats: how many bits a channel is stored in, and conversion between them.
 *
 * This is the project's own small babl (GEGL's format library behind GIMP 2.10, which is what made
 * GIMP's 16/32-bit support possible without rewriting every operation): storage carries a depth,
 * operations declare the format they want, and the boundary converts. An operation that only knows
 * 8-bit therefore keeps working unchanged against a 16-bit layer — it asks for an 8-bit view and
 * gets one — while an operation written for depth reads and writes the real thing.
 *
 * Encoding, stated explicitly because getting it wrong is silent (docs/master-plan.md §59.2):
 * every depth holds the *same* values in the *same* working space, only with more room.
 *   -  8 bit: `Uint8ClampedArray`, 0…255.
 *   - 16 bit: `Uint16Array`, 0…65535 — the range Photoshop calls 16-bit and GIMP calls u16.
 *   - 32 bit: `Float32Array`, 0…1 nominal, **not clamped** — values above 1 and below 0 survive,
 *     which is the actual reason 32-bit exists (highlights recovered from raw, HDR merges, an
 *     exposure adjustment that can be taken back).
 *
 * Deliberately not linear light. Photoshop's 32-bit mode is linear and darktable's pipeline is
 * linear float, and that is a better place to end up; but the transfer function belongs to the
 * document's colour space (`color-space.ts`), not to its depth, and changing both at once would
 * mean every existing adjustment quietly operates on different numbers depending on the depth the
 * document happens to be in. Depth widens the numbers; `image.convertColorSpace` into Linear sRGB
 * is what makes them linear.
 */

export type RasterBitDepth = 8 | 16 | 32;

/** Every buffer kind a layer's pixels can be held in. */
export type PixelBuffer = Uint8ClampedArray | Uint16Array | Float32Array;

export const rasterBitDepths: readonly RasterBitDepth[] = [8, 16, 32];

/** The largest value that means "full" at this depth — 1 for float, where the range is nominal. */
export const depthMaximum = (depth: RasterBitDepth): number => depth === 8 ? 255 : depth === 16 ? 65535 : 1;

export const isRasterBitDepth = (value: unknown): value is RasterBitDepth => value === 8 || value === 16 || value === 32;

/** Which depth a buffer already is, by its own type — no separate field to keep in sync. */
export function bufferDepth(buffer: PixelBuffer): RasterBitDepth {
  if (buffer instanceof Uint16Array) return 16;
  if (buffer instanceof Float32Array) return 32;
  return 8;
}

export function allocatePixels(depth: RasterBitDepth, length: number): PixelBuffer {
  if (depth === 16) return new Uint16Array(length);
  if (depth === 32) return new Float32Array(length);
  return new Uint8ClampedArray(length);
}

/** A buffer of `depth` holding `length` values, copied from `source` if one is given. */
export function pixelsOfDepth(depth: RasterBitDepth, source: PixelBuffer): PixelBuffer {
  return convertPixelDepth(source, bufferDepth(source), depth);
}

/**
 * The same picture in another depth. Returns a copy even when the depth already matches, because
 * every caller here is about to hand the result somewhere that must not alias the original —
 * `TileStore`'s copy-on-write discipline (CLAUDE.md §4) is the whole reason nothing in this package
 * mutates a shared buffer in place.
 *
 * 8↔16 uses ×257 / ÷257, not ×256: 255 must map to 65535 exactly, so that a round trip through
 * 16-bit is the identity and white stays white (the same replication babl and Photoshop do —
 * 0xAB becomes 0xABAB). Float clamps only on the way *down*, where the destination cannot hold
 * out-of-range values anyway; on the way up nothing is clamped, so a 32-bit buffer that already
 * holds highlights above 1 keeps them.
 */
export function convertPixelDepth(source: PixelBuffer, from: RasterBitDepth, to: RasterBitDepth): PixelBuffer {
  if (from === to) return source.slice();
  const output = allocatePixels(to, source.length);
  if (from === 8 && to === 16) { for (let i = 0; i < source.length; i += 1) output[i] = source[i]! * 257; return output; }
  if (from === 16 && to === 8) { for (let i = 0; i < source.length; i += 1) output[i] = Math.round(source[i]! / 257); return output; }
  if (from === 8 && to === 32) { for (let i = 0; i < source.length; i += 1) output[i] = source[i]! / 255; return output; }
  if (from === 32 && to === 8) { for (let i = 0; i < source.length; i += 1) output[i] = Math.round(Math.min(1, Math.max(0, source[i]!)) * 255); return output; }
  if (from === 16 && to === 32) { for (let i = 0; i < source.length; i += 1) output[i] = source[i]! / 65535; return output; }
  for (let i = 0; i < source.length; i += 1) output[i] = Math.round(Math.min(1, Math.max(0, source[i]!)) * 65535);
  return output;
}

/** The 8-bit view every operation that has not been taught about depth asks for. */
export const toRgba8 = (source: PixelBuffer): Uint8ClampedArray =>
  source instanceof Uint8ClampedArray ? source : convertPixelDepth(source, bufferDepth(source), 8) as Uint8ClampedArray;

/** What `toRgba8`'s result is written back as, once an 8-bit operation has finished with it. */
export const fromRgba8 = (pixels: Uint8ClampedArray, depth: RasterBitDepth): PixelBuffer => convertPixelDepth(pixels, 8, depth);

/** Bytes one pixel of `channels` channels costs at this depth — what a depth change actually
 *  charges a document, and what the New Document dialog's own estimate has to say out loud. */
export const bytesPerPixel = (depth: RasterBitDepth, channels = 4): number => (depth === 8 ? 1 : depth === 16 ? 2 : 4) * channels;
