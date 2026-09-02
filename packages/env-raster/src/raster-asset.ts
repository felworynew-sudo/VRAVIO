const MAGIC = 0x56525241; // "VRRA"
const VERSION = 1;
export const HEADER_BYTES = 16;
export const RASTER_ASSET_MIME = "image/vnd.vravio.raster";

export interface RasterAssetImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

/**
 * Raw RGBA carrying its own dimensions.
 *
 * A layer handed to another environment has to be readable from its bytes
 * alone: the receiving side has no access to the document the layer came from,
 * and dimensions kept in asset metadata are lost the moment the bytes are
 * written to a file or handed to a worker. Sixteen bytes of header buy that,
 * and unlike PNG it needs no codec, so the same code decodes it under a test
 * runner and in the browser.
 *
 * Delivery formats stay the business of export; this is what moves between
 * environments, and it is lossless because intermediate revisions must not
 * accumulate compression damage.
 */
export function encodeRasterAsset(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError("Raster asset dimensions must be positive integers");
  }
  if (pixels.length !== width * height * 4) {
    throw new RangeError(`Raster asset needs ${width * height * 4} bytes of pixels, got ${pixels.length}`);
  }
  const bytes = new Uint8Array(HEADER_BYTES + pixels.length);
  const header = new DataView(bytes.buffer, 0, HEADER_BYTES);
  header.setUint32(0, MAGIC, false);
  header.setUint32(4, VERSION, false);
  header.setUint32(8, width, false);
  header.setUint32(12, height, false);
  bytes.set(pixels, HEADER_BYTES);
  return bytes;
}

export function decodeRasterAsset(bytes: Uint8Array): RasterAssetImage {
  if (bytes.length < HEADER_BYTES) throw new RangeError("Not a raster asset: too short for a header");
  const header = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  if (header.getUint32(0, false) !== MAGIC) throw new RangeError("Not a raster asset: wrong magic");
  const version = header.getUint32(4, false);
  if (version !== VERSION) throw new RangeError(`Unsupported raster asset version: ${version}`);
  const width = header.getUint32(8, false), height = header.getUint32(12, false);
  const expected = width * height * 4;
  if (bytes.length - HEADER_BYTES !== expected) {
    throw new RangeError(`Raster asset claims ${width}x${height} but carries ${bytes.length - HEADER_BYTES} bytes`);
  }
  // Copied rather than viewed: the caller owns the result and will paint on it.
  return { width, height, pixels: new Uint8ClampedArray(bytes.slice(HEADER_BYTES)) };
}

/** Whether these bytes are one of ours, without throwing to find out. */
export function isRasterAsset(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES) return false;
  return new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES).getUint32(0, false) === MAGIC;
}
