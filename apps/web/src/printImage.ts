/**
 * Print pipeline — replaces the bare `window.print()` stub that used to sit on the File menu
 * (it printed the live dark-themed app chrome, not the artwork, with no control over paper
 * size, scale, or placement at all). Ported from Patchy's `ui/print_layout.cpp`: paper size +
 * margins + scale mode (actual/fit/custom) + centering/offset + crop marks, computed in
 * physical inches from the document's own resolution, then rasterized once into a single
 * page-sized image — the same "app draws the whole page, printer just rasterizes it" shape as
 * Patchy's `render_print_page` (a `QPainter` there; an offscreen `<canvas>` here).
 */
import { compositeRasterDocument, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";

export type PrintAreaMode = "document" | "selection";
export type PrintScaleMode = "actual" | "fit" | "custom";
export type PrintOrientation = "portrait" | "landscape";

export interface PaperSize {
  readonly id: string;
  readonly label: string;
  readonly widthIn: number;
  readonly heightIn: number;
}

// Physical page sizes in inches — the same units the placement math below works in throughout,
// since document size only has physical meaning through its own resolution (pixels / ppi).
export const paperSizes: readonly PaperSize[] = [
  { id: "letter", label: "Letter · 8.5×11 in", widthIn: 8.5, heightIn: 11 },
  { id: "legal", label: "Legal · 8.5×14 in", widthIn: 8.5, heightIn: 14 },
  { id: "tabloid", label: "Tabloid · 11×17 in", widthIn: 11, heightIn: 17 },
  { id: "a3", label: "A3 · 297×420 mm", widthIn: 11.69, heightIn: 16.54 },
  { id: "a4", label: "A4 · 210×297 mm", widthIn: 8.27, heightIn: 11.69 },
  { id: "a5", label: "A5 · 148×210 mm", widthIn: 5.83, heightIn: 8.27 },
];

export function paperSizeInfo(id: string): PaperSize {
  return paperSizes.find((candidate) => candidate.id === id) ?? paperSizes[0]!;
}

export interface PrintSettings {
  readonly paperSizeId: string;
  readonly orientation: PrintOrientation;
  readonly marginTopIn: number;
  readonly marginRightIn: number;
  readonly marginBottomIn: number;
  readonly marginLeftIn: number;
  readonly areaMode: PrintAreaMode;
  readonly scaleMode: PrintScaleMode;
  readonly scalePercent: number;
  readonly center: boolean;
  readonly offsetXIn: number;
  readonly offsetYIn: number;
  readonly cropMarks: boolean;
}

export const defaultPrintSettings: PrintSettings = {
  paperSizeId: "letter",
  orientation: "portrait",
  marginTopIn: 0.5, marginRightIn: 0.5, marginBottomIn: 0.5, marginLeftIn: 0.5,
  areaMode: "document",
  scaleMode: "fit",
  scalePercent: 100,
  center: true,
  offsetXIn: 0, offsetYIn: 0,
  cropMarks: false,
};

/** Same fallback Patchy's `sanitized_ppi` uses — an unset or corrupt resolution prints at
 * 300 ppi rather than dividing by a zero/NaN and producing an infinite or empty page size. */
export function documentPpi(state: Pick<RasterDocumentState, "resolution" | "resolutionUnit">): number {
  const value = Number.isFinite(state.resolution) && state.resolution > 0 ? state.resolution : 300;
  return state.resolutionUnit === "ppcm" ? value * 2.54 : value;
}

export interface PageLayout {
  readonly widthIn: number;
  readonly heightIn: number;
  readonly printableWidthIn: number;
  readonly printableHeightIn: number;
  readonly marginLeftIn: number;
  readonly marginTopIn: number;
}

export function pageLayoutFor(settings: PrintSettings): PageLayout {
  const paper = paperSizeInfo(settings.paperSizeId);
  const widthIn = settings.orientation === "landscape" ? paper.heightIn : paper.widthIn;
  const heightIn = settings.orientation === "landscape" ? paper.widthIn : paper.heightIn;
  return {
    widthIn, heightIn,
    printableWidthIn: Math.max(0, widthIn - settings.marginLeftIn - settings.marginRightIn),
    printableHeightIn: Math.max(0, heightIn - settings.marginTopIn - settings.marginBottomIn),
    marginLeftIn: settings.marginLeftIn, marginTopIn: settings.marginTopIn,
  };
}

export interface PrintPlacement {
  readonly sourceRect: RasterRect;
  readonly targetXIn: number;
  readonly targetYIn: number;
  readonly targetWidthIn: number;
  readonly targetHeightIn: number;
  readonly effectiveScalePercent: number;
}

function sourceRectFor(state: RasterDocumentState, settings: PrintSettings): RasterRect {
  const full: RasterRect = { x: 0, y: 0, width: state.width, height: state.height };
  if (settings.areaMode !== "selection" || !state.selection) return full;
  const bounds = state.selection.bounds;
  return bounds.width > 0 && bounds.height > 0 ? bounds : full;
}

function sanitizedScalePercent(value: number): number {
  return Math.max(1, Math.min(1000, Number.isFinite(value) ? value : 100));
}

export function calculatePrintPlacement(state: RasterDocumentState, settings: PrintSettings, page: PageLayout): PrintPlacement {
  const source = sourceRectFor(state, settings);
  const ppi = documentPpi(state);
  const actualWidthIn = source.width / ppi, actualHeightIn = source.height / ppi;

  let targetWidthIn = actualWidthIn, targetHeightIn = actualHeightIn, effectiveScalePercent = 100;
  if (settings.scaleMode === "fit" && actualWidthIn > 0 && actualHeightIn > 0 && page.printableWidthIn > 0 && page.printableHeightIn > 0) {
    const fit = Math.min(page.printableWidthIn / actualWidthIn, page.printableHeightIn / actualHeightIn);
    targetWidthIn = actualWidthIn * fit; targetHeightIn = actualHeightIn * fit;
    effectiveScalePercent = fit * 100;
  } else if (settings.scaleMode === "custom") {
    effectiveScalePercent = sanitizedScalePercent(settings.scalePercent);
    targetWidthIn = actualWidthIn * (effectiveScalePercent / 100); targetHeightIn = actualHeightIn * (effectiveScalePercent / 100);
  }

  const targetXIn = settings.center ? page.marginLeftIn + (page.printableWidthIn - targetWidthIn) / 2 : page.marginLeftIn + settings.offsetXIn;
  const targetYIn = settings.center ? page.marginTopIn + (page.printableHeightIn - targetHeightIn) / 2 : page.marginTopIn + settings.offsetYIn;

  return { sourceRect: source, targetXIn, targetYIn, targetWidthIn, targetHeightIn, effectiveScalePercent };
}

/** Physical-to-pixel density for the rasterized page — independent of the document's own
 * resolution (a 72 ppi document scaled to fill a page still deserves a crisp printed page). */
/** The full-resolution page sent to the operating system. */
export const PRINT_OUTPUT_DPI = 300;
/** Screen-sized preview: deliberately independent from output quality. */
export const PRINT_PREVIEW_DPI = 96;
const CROP_MARK_LENGTH_IN = 0.25, CROP_MARK_GAP_IN = 0.07;

function drawCropMarks(context: CanvasRenderingContext2D, dpi: number, x: number, y: number, width: number, height: number): void {
  const length = CROP_MARK_LENGTH_IN * dpi, gap = CROP_MARK_GAP_IN * dpi;
  const left = x, right = x + width, top = y, bottom = y + height;
  context.save();
  // 2px at print resolution (≈0.17mm at 300dpi): a true 1px stroke lands on the pixel grid
  // boundary and gets anti-aliased to a faint ~50%-gray smear across two rows instead of a
  // crisp line — found by sampling the rendered canvas directly, not by eye.
  context.strokeStyle = "#141414"; context.lineWidth = 2;
  context.beginPath();
  context.moveTo(left - gap - length, top); context.lineTo(left - gap, top);
  context.moveTo(left, top - gap - length); context.lineTo(left, top - gap);
  context.moveTo(right + gap, top); context.lineTo(right + gap + length, top);
  context.moveTo(right, top - gap - length); context.lineTo(right, top - gap);
  context.moveTo(left - gap - length, bottom); context.lineTo(left - gap, bottom);
  context.moveTo(left, bottom + gap); context.lineTo(left, bottom + gap + length);
  context.moveTo(right + gap, bottom); context.lineTo(right + gap + length, bottom);
  context.moveTo(right, bottom + gap); context.lineTo(right, bottom + gap + length);
  context.stroke();
  context.restore();
}

/**
 * Rasterizes one full print page — background, placed artwork, optional crop marks — at
 * `PRINT_OUTPUT_DPI`. `drawPrintableGuide` overlays a dashed outline of the margin box; it is
 * a preview-only aid (mirrors Patchy's own `draw_printable_guide` flag) and must be left off
 * for the page that actually gets handed to the printer.
 */
export function renderPrintPageFromPixels(
  state: RasterDocumentState,
  settings: PrintSettings,
  pixels: Uint8ClampedArray,
  drawPrintableGuide = false,
  dpi = PRINT_OUTPUT_DPI,
): HTMLCanvasElement {
  const page = pageLayoutFor(settings);
  const placement = calculatePrintPlacement(state, settings, page);
  const safeDpi = Math.max(36, Math.min(PRINT_OUTPUT_DPI, Math.round(dpi)));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(page.widthIn * safeDpi));
  canvas.height = Math.max(1, Math.round(page.heightIn * safeDpi));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const { sourceRect } = placement;
  if (sourceRect.width > 0 && sourceRect.height > 0 && placement.targetWidthIn > 0 && placement.targetHeightIn > 0) {
    const source = document.createElement("canvas");
    source.width = state.width; source.height = state.height;
    const sourceContext = source.getContext("2d");
    if (!sourceContext) throw new Error("Canvas 2D is not available");
    sourceContext.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, state.width, state.height), 0, 0);

    const targetX = placement.targetXIn * safeDpi, targetY = placement.targetYIn * safeDpi;
    const targetWidth = placement.targetWidthIn * safeDpi, targetHeight = placement.targetHeightIn * safeDpi;
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
    context.drawImage(source, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, targetX, targetY, targetWidth, targetHeight);
    if (settings.cropMarks) drawCropMarks(context, safeDpi, targetX, targetY, targetWidth, targetHeight);
  }

  if (drawPrintableGuide) {
    context.save();
    context.strokeStyle = "#cdcdcd"; context.setLineDash([6, 4]); context.lineWidth = 1;
    context.strokeRect(page.marginLeftIn * safeDpi, page.marginTopIn * safeDpi, page.printableWidthIn * safeDpi, page.printableHeightIn * safeDpi);
    context.restore();
  }
  return canvas;
}

/** Convenience path for one-off renders. Interactive consumers should composite once and use
 * `renderPrintPageFromPixels` while the user changes layout controls. */
export function renderPrintPage(state: RasterDocumentState, settings: PrintSettings, drawPrintableGuide = false, dpi = PRINT_OUTPUT_DPI): HTMLCanvasElement {
  return renderPrintPageFromPixels(state, settings, compositeRasterDocument(state), drawPrintableGuide, dpi);
}

/** A hidden iframe with an `@page` rule sized to the physical page and a full-bleed image of
 * the already-rasterized page — the browser's print pipeline gets exact control over paper
 * size and placement without fighting its own default print margins or page-fit scaling. */
export function openPrintPreview(pageDataUrl: string, page: PageLayout): void {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed"; iframe.style.right = "0"; iframe.style.bottom = "0";
  iframe.style.width = "0"; iframe.style.height = "0"; iframe.style.border = "0"; iframe.style.visibility = "hidden";
  document.body.appendChild(iframe);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    iframe.remove();
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${page.widthIn}in ${page.heightIn}in; margin: 0; }
    html, body { margin: 0; padding: 0; }
    img { display: block; width: ${page.widthIn}in; height: ${page.heightIn}in; }
  </style></head><body><img src="${pageDataUrl}"/></body></html>`;
  const target = iframe.contentWindow;
  if (!target) { cleanup(); throw new Error("Could not open the print preview frame"); }
  target.document.open(); target.document.write(html); target.document.close();
  const image = target.document.querySelector("img");
  const triggerPrint = () => {
    target.addEventListener("afterprint", cleanup, { once: true });
    target.focus(); target.print();
    // Some browser engines do not dispatch `afterprint` for a hidden frame. Keep it alive while
    // the native dialog is open, then release it even on those engines.
    window.setTimeout(cleanup, 60_000);
  };
  if (image && !image.complete) image.addEventListener("load", triggerPrint, { once: true });
  else triggerPrint();
}
