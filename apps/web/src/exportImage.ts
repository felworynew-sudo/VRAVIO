import { compositeRasterDocument, type RasterDocumentState } from "@vravio/env-raster";

export type ExportFormat = "png" | "jpeg" | "webp" | "avif" | "tiff" | "bmp" | "ico" | "pdf";
export type ExportColorMode = "rgba" | "rgb" | "grayscale" | "monochrome" | "indexed";
export type ExportResampling = "nearest" | "bilinear" | "bicubic";

export interface ExportFormatInfo {
  readonly format: ExportFormat;
  readonly label: string;
  readonly mime: string;
  readonly extension: string;
  /** Lossy formats expose the quality slider and can hit a target file size. */
  readonly lossy: boolean;
  readonly alpha: boolean;
  readonly notes: string;
}

export const exportFormats: readonly ExportFormatInfo[] = [
  { format: "png", label: "PNG", mime: "image/png", extension: "png", lossy: false, alpha: true, notes: "Lossless, transparency" },
  { format: "jpeg", label: "JPEG", mime: "image/jpeg", extension: "jpg", lossy: true, alpha: false, notes: "Photos, adjustable quality" },
  { format: "webp", label: "WebP", mime: "image/webp", extension: "webp", lossy: true, alpha: true, notes: "Compact web image, transparency" },
  { format: "avif", label: "AVIF", mime: "image/avif", extension: "avif", lossy: true, alpha: true, notes: "Modern high compression" },
  { format: "tiff", label: "TIFF", mime: "image/tiff", extension: "tif", lossy: false, alpha: true, notes: "Uncompressed RGBA master" },
  { format: "bmp", label: "BMP", mime: "image/bmp", extension: "bmp", lossy: false, alpha: false, notes: "Uncompressed 24-bit RGB" },
  { format: "ico", label: "ICO", mime: "image/x-icon", extension: "ico", lossy: false, alpha: true, notes: "PNG-compressed Windows icon" },
  { format: "pdf", label: "PDF", mime: "application/pdf", extension: "pdf", lossy: false, alpha: false, notes: "Single-page document" },
];

export function exportFormatInfo(format: ExportFormat): ExportFormatInfo {
  const info = exportFormats.find((candidate) => candidate.format === format);
  if (!info) throw new RangeError(`Unknown export format: ${format}`);
  return info;
}

export interface ExportSettings {
  readonly format: ExportFormat;
  /** 0..1. Ignored by lossless formats. */
  readonly quality: number;
  /** Output scale multiplier; 1 renders at document size. */
  readonly scale: number;
  /** Flattened behind the image when the format has no alpha channel. */
  readonly background: string;
  readonly colorMode: ExportColorMode;
  readonly paletteColors: number;
  readonly dither: boolean;
  readonly resampling: ExportResampling;
}

export const defaultExportSettings: ExportSettings = { format: "png", quality: 0.9, scale: 1, background: "#ffffff", colorMode: "rgba", paletteColors: 256, dither: false, resampling: "bicubic" };

/**
 * A canvas encoder is only usable if the browser actually produces that MIME type —
 * `toBlob` silently falls back to PNG for formats it cannot encode, which would
 * otherwise hand the user a `.avif` file containing PNG bytes.
 */
async function canEncode(mime: string): Promise<boolean> {
  const probe = document.createElement("canvas");
  probe.width = 1; probe.height = 1;
  const blob = await new Promise<Blob | null>((resolve) => probe.toBlob(resolve, mime, 0.5));
  return blob?.type === mime;
}

let supportedCache: Promise<ReadonlySet<ExportFormat>> | null = null;

export function supportedExportFormats(): Promise<ReadonlySet<ExportFormat>> {
  supportedCache ??= (async () => {
    const supported = new Set<ExportFormat>(["png", "tiff", "bmp", "ico", "pdf"]);
    for (const info of exportFormats) {
      if (supported.has(info.format) || info.format === "pdf") continue;
      if (await canEncode(info.mime)) supported.add(info.format);
    }
    return supported;
  })();
  return supportedCache;
}

export function exportPixelSize(state: RasterDocumentState, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(state.width * scale)), height: Math.max(1, Math.round(state.height * scale)) };
}

/** Composites the document and scales it to the requested output size. */
function reduceColours(image: ImageData, mode: ExportColorMode, paletteColors: number, dither: boolean): void {
  if (mode === "rgba" || mode === "rgb") return;
  const data = image.data, width = image.width, height = image.height;
  const levels = Math.max(2, Math.min(256, Math.round(paletteColors)));
  const channelLevels = Math.max(2, Math.floor(Math.cbrt(levels)));
  const quantize = (value: number, count: number) => Math.round(value * (count - 1) / 255) * 255 / (count - 1);
  const error = dither ? new Float32Array(width * height) : null;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const pixel = y * width + x, index = pixel * 4;
    if (mode === "grayscale" || mode === "monochrome") {
      const original = data[index]! * 0.2126 + data[index + 1]! * 0.7152 + data[index + 2]! * 0.0722 + (error?.[pixel] ?? 0);
      const next = mode === "monochrome" ? (original >= 127.5 ? 255 : 0) : quantize(Math.max(0, Math.min(255, original)), levels);
      data[index] = next; data[index + 1] = next; data[index + 2] = next;
      if (error) {
        const difference = original - next;
        if (x + 1 < width) error[pixel + 1]! += difference * 7 / 16;
        if (y + 1 < height) {
          if (x > 0) error[pixel + width - 1]! += difference * 3 / 16;
          error[pixel + width]! += difference * 5 / 16;
          if (x + 1 < width) error[pixel + width + 1]! += difference / 16;
        }
      }
    } else {
      data[index] = quantize(data[index]!, channelLevels);
      data[index + 1] = quantize(data[index + 1]!, channelLevels);
      data[index + 2] = quantize(data[index + 2]!, Math.max(2, Math.floor(levels / (channelLevels * channelLevels))));
    }
  }
}

export function renderExportCanvas(state: RasterDocumentState, settings: Pick<ExportSettings, "scale" | "format" | "background" | "colorMode" | "paletteColors" | "dither" | "resampling">): HTMLCanvasElement {
  const source = document.createElement("canvas");
  source.width = state.width; source.height = state.height;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) throw new Error("Canvas 2D is not available");
  sourceContext.putImageData(new ImageData(compositeRasterDocument(state) as Uint8ClampedArray<ArrayBuffer>, state.width, state.height), 0, 0);

  const { width, height } = exportPixelSize(state, settings.scale);
  const needsFlatten = !exportFormatInfo(settings.format).alpha || settings.colorMode === "rgb";
  const needsColourConversion = settings.colorMode !== "rgba" && settings.colorMode !== "rgb";
  if (width === state.width && height === state.height && !needsFlatten && !needsColourConversion) return source;

  const target = document.createElement("canvas");
  target.width = width; target.height = height;
  const context = target.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  if (needsFlatten) { context.fillStyle = settings.background; context.fillRect(0, 0, width, height); }
  context.imageSmoothingEnabled = settings.resampling !== "nearest";
  context.imageSmoothingQuality = settings.resampling === "bicubic" ? "high" : "low";
  context.drawImage(source, 0, 0, width, height);
  if (needsColourConversion) {
    const image = context.getImageData(0, 0, width, height);
    reduceColours(image, settings.colorMode, settings.paletteColors, settings.dither);
    context.putImageData(image, 0, 0);
  }
  return target;
}

function canvasPixels(canvas: HTMLCanvasElement): Uint8ClampedArray { return canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data; }

export function encodeBmpPixels(width: number, height: number, rgba: Uint8ClampedArray): Blob {
  const rowSize = Math.ceil(width * 3 / 4) * 4, pixelBytes = rowSize * height;
  const buffer = new ArrayBuffer(54 + pixelBytes), view = new DataView(buffer), bytes = new Uint8Array(buffer);
  bytes[0] = 0x42; bytes[1] = 0x4d; view.setUint32(2, buffer.byteLength, true); view.setUint32(10, 54, true);
  view.setUint32(14, 40, true); view.setInt32(18, width, true); view.setInt32(22, height, true); view.setUint16(26, 1, true); view.setUint16(28, 24, true); view.setUint32(34, pixelBytes, true);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const source = ((height - 1 - y) * width + x) * 4, target = 54 + y * rowSize + x * 3;
    bytes[target] = rgba[source + 2]!; bytes[target + 1] = rgba[source + 1]!; bytes[target + 2] = rgba[source]!;
  }
  return new Blob([buffer], { type: "image/bmp" });
}

function encodeBmp(canvas: HTMLCanvasElement): Blob { return encodeBmpPixels(canvas.width, canvas.height, canvasPixels(canvas)); }

export function encodeTiffPixels(width: number, height: number, pixels: Uint8ClampedArray): Blob {
  const entries = 14;
  const ifdOffset = 8, ifdSize = 2 + entries * 12 + 4, bitsOffset = ifdOffset + ifdSize, xResolutionOffset = bitsOffset + 8, yResolutionOffset = xResolutionOffset + 8, pixelOffset = yResolutionOffset + 8;
  const buffer = new ArrayBuffer(pixelOffset + pixels.length), view = new DataView(buffer), bytes = new Uint8Array(buffer);
  bytes[0] = 0x49; bytes[1] = 0x49; view.setUint16(2, 42, true); view.setUint32(4, ifdOffset, true); view.setUint16(ifdOffset, entries, true);
  let entry = ifdOffset + 2;
  const add = (tag: number, type: number, count: number, value: number) => { view.setUint16(entry, tag, true); view.setUint16(entry + 2, type, true); view.setUint32(entry + 4, count, true); if (type === 3 && count === 1) view.setUint16(entry + 8, value, true); else view.setUint32(entry + 8, value, true); entry += 12; };
  add(256, 4, 1, width); add(257, 4, 1, height); add(258, 3, 4, bitsOffset); add(259, 3, 1, 1); add(262, 3, 1, 2); add(273, 4, 1, pixelOffset); add(277, 3, 1, 4); add(278, 4, 1, height); add(279, 4, 1, pixels.length); add(282, 5, 1, xResolutionOffset); add(283, 5, 1, yResolutionOffset); add(284, 3, 1, 1); add(296, 3, 1, 2); add(338, 3, 1, 2);
  view.setUint32(entry, 0, true); [8, 8, 8, 8].forEach((value, index) => view.setUint16(bitsOffset + index * 2, value, true));
  view.setUint32(xResolutionOffset, 72, true); view.setUint32(xResolutionOffset + 4, 1, true); view.setUint32(yResolutionOffset, 72, true); view.setUint32(yResolutionOffset + 4, 1, true); bytes.set(pixels, pixelOffset);
  return new Blob([buffer], { type: "image/tiff" });
}

function encodeTiff(canvas: HTMLCanvasElement): Blob { return encodeTiffPixels(canvas.width, canvas.height, canvasPixels(canvas)); }

async function encodeIco(canvas: HTMLCanvasElement): Promise<Blob> {
  if (canvas.width > 256 || canvas.height > 256) throw new RangeError("ICO dimensions cannot exceed 256 × 256 px");
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png) throw new Error("Failed to encode ICO image");
  const payload = new Uint8Array(await png.arrayBuffer()), buffer = new ArrayBuffer(22 + payload.length), view = new DataView(buffer), bytes = new Uint8Array(buffer);
  view.setUint16(0, 0, true); view.setUint16(2, 1, true); view.setUint16(4, 1, true);
  bytes[6] = canvas.width >= 256 ? 0 : canvas.width; bytes[7] = canvas.height >= 256 ? 0 : canvas.height; bytes[8] = 0; bytes[9] = 0;
  view.setUint16(10, 1, true); view.setUint16(12, 32, true); view.setUint32(14, payload.length, true); view.setUint32(18, 22, true); bytes.set(payload, 22);
  return new Blob([buffer], { type: "image/x-icon" });
}

async function encodeCanvas(canvas: HTMLCanvasElement, format: ExportFormat, quality: number): Promise<Blob> {
  const info = exportFormatInfo(format);
  if (format === "bmp") return encodeBmp(canvas);
  if (format === "tiff") return encodeTiff(canvas);
  if (format === "ico") return encodeIco(canvas);
  if (format === "pdf") {
    const { jsPDF } = await import("jspdf");
    const orientation = canvas.width >= canvas.height ? "landscape" : "portrait";
    const pdf = new jsPDF({ orientation, unit: "px", format: [canvas.width, canvas.height], compress: true });
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, canvas.width, canvas.height);
    return pdf.output("blob");
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, info.mime, info.lossy ? quality : undefined));
  if (!blob) throw new Error(`Failed to encode ${info.label}`);
  return blob;
}

export interface EncodeResult {
  readonly blob: Blob;
  /** The quality actually used — differs from the request when hitting a target size. */
  readonly quality: number;
  /** Set when a target size was requested but could not be met even at minimum quality. */
  readonly targetMissed?: boolean;
}

/**
 * Binary-searches quality so the encoded file lands at or just under `targetBytes`.
 * Lossless formats cannot trade quality for size, so they encode once and report
 * whether they overshot.
 */
export async function encodeToTargetBytes(canvas: HTMLCanvasElement, format: ExportFormat, targetBytes: number, steps = 8): Promise<EncodeResult> {
  const info = exportFormatInfo(format);
  if (!info.lossy) {
    const blob = await encodeCanvas(canvas, format, 1);
    return blob.size <= targetBytes ? { blob, quality: 1 } : { blob, quality: 1, targetMissed: true };
  }
  let low = 0.02, high = 1, best: Blob | null = null, bestQuality = low;
  const ceiling = await encodeCanvas(canvas, format, high);
  if (ceiling.size <= targetBytes) return { blob: ceiling, quality: high };
  for (let step = 0; step < steps; step += 1) {
    const middle = (low + high) / 2;
    const blob = await encodeCanvas(canvas, format, middle);
    if (blob.size <= targetBytes) { best = blob; bestQuality = middle; low = middle; } else high = middle;
  }
  if (best) return { blob: best, quality: bestQuality };
  const floor = await encodeCanvas(canvas, format, 0.02);
  return { blob: floor, quality: 0.02, targetMissed: true };
}

export async function encodeExport(state: RasterDocumentState, settings: ExportSettings, targetBytes?: number): Promise<EncodeResult> {
  const canvas = renderExportCanvas(state, settings);
  if (targetBytes && targetBytes > 0) return encodeToTargetBytes(canvas, settings.format, targetBytes);
  return { blob: await encodeCanvas(canvas, settings.format, settings.quality), quality: settings.quality };
}

export function exportFileName(documentName: string, format: ExportFormat): string {
  const stem = documentName.replace(/\s*\([^()]*\)\s*$/, "").replace(/\.[^.]+$/, "").trim() || "untitled";
  return `${stem}.${exportFormatInfo(format).extension}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
