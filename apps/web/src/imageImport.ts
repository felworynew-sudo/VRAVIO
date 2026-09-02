export interface DecodedImportSource {
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  release(): void;
}

/** SVG without an intrinsic size still has to land on a sensible canvas. */
const SVG_FALLBACK = { width: 1024, height: 1024 };
const SVG_MAX = 4096;

function svgIntrinsicSize(markup: string): { width: number; height: number } {
  const root = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
  const asPixels = (value: string | null): number => {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const width = asPixels(root.getAttribute("width")), height = asPixels(root.getAttribute("height"));
  if (width && height) return { width, height };
  // Fall back to the viewBox, which is what most icon and logo files carry instead.
  const viewBox = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0) {
    return { width: viewBox[2]!, height: viewBox[3]! };
  }
  return SVG_FALLBACK;
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image failed to load"));
    image.src = url;
  });
}

/**
 * Decodes an imported file into something drawable.
 *
 * SVG cannot go through `createImageBitmap`: browsers disagree on how to size a vector without
 * an intrinsic width/height, and several return a 0×0 bitmap. Rasterizing through an <img> at a
 * size we compute ourselves gives the same result everywhere.
 */
export async function decodeImportedImage(file: File): Promise<DecodedImportSource | null> {
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  if (isSvg) {
    const markup = await file.text();
    const intrinsic = svgIntrinsicSize(markup);
    const scale = Math.min(1, SVG_MAX / Math.max(intrinsic.width, intrinsic.height));
    const width = Math.max(1, Math.round(intrinsic.width * scale)), height = Math.max(1, Math.round(intrinsic.height * scale));
    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
    try {
      const image = await loadImageElement(url);
      return { image, width, height, release: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      return null;
    }
  }
  try {
    const bitmap = await createImageBitmap(file);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    return null;
  }
}
