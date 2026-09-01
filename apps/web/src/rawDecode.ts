import LibRaw from "libraw-wasm";
import { diagnostic } from "./diagnostics";
import { extractRawPreviewJpeg } from "./rawPreview";

/** Extensions LibRaw-Wasm can open — CR2/CR3/NEF/ARW/RAF/DNG "and more" per its README. */
export const rawFileExtensions = ["cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "dng", "orf", "ptx", "pef", "rw2", "raw", "rwl", "srw", "3fr", "dcr", "kdc", "erf", "mef", "mos", "iiq", "x3f"] as const;

export function rawExtensionOf(filename: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  return match ? match[1]!.toLowerCase() : null;
}

export interface CameraRawSettings {
  exposure: number; // expShift, linear scale around 1
  brightness: number; // bright
  useCameraWb: boolean;
  useAutoWb: boolean;
  highlight: number; // 0..9
}

export const defaultCameraRawSettings: CameraRawSettings = { exposure: 1, brightness: 1, useCameraWb: true, useAutoWb: false, highlight: 0 };

export interface DecodedRaw { width: number; height: number; pixels: Uint8ClampedArray }

function toRgba(image: { width: number; height: number; colors: number; data: Uint8Array | Uint16Array }): Uint8ClampedArray {
  const { width, height, colors, data } = image, pixels = new Uint8ClampedArray(width * height * 4), scale = data instanceof Uint16Array ? 255 / 65535 : 1;
  for (let pixel = 0, source = 0; pixel < width * height; pixel += 1, source += colors) {
    const r = data[source]! * scale, g = colors >= 2 ? data[source + 1]! * scale : r, b = colors >= 3 ? data[source + 2]! * scale : r;
    const target = pixel * 4; pixels[target] = r; pixels[target + 1] = g; pixels[target + 2] = b; pixels[target + 3] = 255;
  }
  return pixels;
}

export async function fallbackToEmbeddedPreview(buffer: ArrayBuffer, filename: string): Promise<DecodedRaw | null> {
  const preview = extractRawPreviewJpeg(buffer);
  if (!preview) { diagnostic("error", "Import", `${filename}: no embedded preview found either — this file could not be opened.`); return null; }
  const bitmap = await createImageBitmap(new Blob([preview.slice()], { type: "image/jpeg" }));
  const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0); bitmap.close();
  return { width: canvas.width, height: canvas.height, pixels: new Uint8ClampedArray(context.getImageData(0, 0, canvas.width, canvas.height).data) };
}

/** Real RAW develop (demosaic + white balance + exposure) via LibRaw-Wasm; falls back to the embedded JPEG preview if LibRaw can't decode this file. */
export async function decodeRawBuffer(buffer: ArrayBuffer, filename: string, settings: CameraRawSettings = defaultCameraRawSettings): Promise<DecodedRaw | null> {
  const raw = new LibRaw();
  try {
    await raw.open(new Uint8Array(buffer.slice(0)), {
      outputBps: 8, outputColor: 1,
      useCameraWb: settings.useCameraWb, useAutoWb: settings.useAutoWb,
      expCorrec: true, expShift: settings.exposure, bright: settings.brightness, highlight: settings.highlight,
    });
    const image = await raw.imageData();
    raw.dispose();
    if (!image) { diagnostic("warn", "Import", `${filename}: LibRaw decoded no image data for this file. Falling back to the embedded JPEG preview if one is present.`); return fallbackToEmbeddedPreview(buffer, filename); }
    diagnostic("info", "Import", `${filename}: developed via LibRaw (demosaic + white balance) — ${image.width}×${image.height}.`);
    return { width: image.width, height: image.height, pixels: toRgba(image) };
  } catch (error) {
    raw.dispose();
    diagnostic("warn", "Import", `${filename}: LibRaw could not decode this file (${error instanceof Error ? error.message : String(error)}). Falling back to the embedded JPEG preview if one is present.`);
    return fallbackToEmbeddedPreview(buffer, filename);
  }
}
