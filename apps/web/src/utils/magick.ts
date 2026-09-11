import { ImageMagick, initializeImageMagick, MagickFormat, type IMagickImage } from "@imagemagick/magick-wasm";
// The package's plain export (as opposed to "x64/magick.wasm") is the x86 build — the one that
// actually runs in a browser; "x64/" is a memory64 build for Node and fails to link here with a
// LinkError ("function import requires a callable"), confirmed live before picking this one.
import magickWasmUrl from "@imagemagick/magick-wasm/magick.wasm?url";

/**
 * The WASM binary is ~15 MB — loaded once, lazily, only when a format outside the browser's
 * native decode/encode set is actually requested (see `ImageConverter.tsx`'s canvas-first path).
 */
let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  ready ??= initializeImageMagick(new URL(magickWasmUrl, window.location.href));
  return ready;
}

function isKnownFormat(name: string): name is keyof typeof MagickFormat {
  return name in MagickFormat;
}

/**
 * Decodes `bytes` and re-encodes as `outputFormat` (an `ImageMagick.MagickFormat` key, e.g.
 * `"WebP"`). `inputFormatHint` disambiguates containers ImageMagick can't sniff from magic bytes
 * alone (TGA and friends — see `ImageConverter.tsx`'s `EXT2MAGICK`); omit it to let ImageMagick
 * detect the format itself.
 */
export async function magickConvert(bytes: Uint8Array, outputFormat: string, quality?: number, inputFormatHint?: string | null): Promise<Uint8Array> {
  await ensureReady();
  if (!isKnownFormat(outputFormat)) throw new Error(`Unknown output format: ${outputFormat}`);
  const format = MagickFormat[outputFormat];
  const encode = (image: IMagickImage): Uint8Array => {
    if (quality !== undefined) image.quality = quality;
    return image.write(format, (data) => new Uint8Array(data));
  };
  if (inputFormatHint && isKnownFormat(inputFormatHint)) return ImageMagick.read(bytes, MagickFormat[inputFormatHint], encode);
  return ImageMagick.read(bytes, encode);
}
