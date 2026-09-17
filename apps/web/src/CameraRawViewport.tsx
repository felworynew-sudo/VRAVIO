import { useEffect, useRef, useState } from "react";
import { cameraRawRegionMargin, type CameraRawFilterSettings } from "@vravio/env-raster";
import { renderCameraRaw } from "./camera-raw-pool";
import { text } from "./i18n";
import type { Language } from "./store";

export interface CameraRawImage {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Optional step after the develop pipeline (AI Denoise), run on exactly the pixels on screen. */
export type CameraRawPostProcess = (pixels: Uint8ClampedArray, width: number, height: number, signal: AbortSignal) => Promise<Uint8ClampedArray>;

type View = { readonly mode: "fit" } | { readonly mode: "zoom"; readonly scale: number; readonly centerX: number; readonly centerY: number };

const MIN_SCALE = 0.02, MAX_SCALE = 8;

/**
 * Area-average resample of `source` by a fractional `scale` < 1 — each output pixel the mean of the
 * source pixels its footprint covers. The preview used to take one source pixel per output pixel,
 * which is where its jagged, noisy look came from.
 */
function areaDownsample(source: Uint8ClampedArray, width: number, height: number, scale: number): CameraRawImage {
  const outWidth = Math.max(1, Math.round(width * scale)), outHeight = Math.max(1, Math.round(height * scale));
  const output = new Uint8ClampedArray(outWidth * outHeight * 4);
  const stepX = width / outWidth, stepY = height / outHeight;
  for (let oy = 0; oy < outHeight; oy += 1) {
    const y0 = Math.floor(oy * stepY), y1 = Math.max(y0 + 1, Math.min(height, Math.floor((oy + 1) * stepY)));
    for (let ox = 0; ox < outWidth; ox += 1) {
      const x0 = Math.floor(ox * stepX), x1 = Math.max(x0 + 1, Math.min(width, Math.floor((ox + 1) * stepX)));
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0, index = (y * width + x0) * 4; x < x1; x += 1, index += 4) { r += source[index]!; g += source[index + 1]!; b += source[index + 2]!; a += source[index + 3]!; }
      const count = (y1 - y0) * (x1 - x0), target = (oy * outWidth + ox) * 4;
      output[target] = r / count; output[target + 1] = g / count; output[target + 2] = b / count; output[target + 3] = a / count;
    }
  }
  return { pixels: output, width: outWidth, height: outHeight };
}

function crop(image: CameraRawImage, x0: number, y0: number, x1: number, y1: number): CameraRawImage {
  const width = x1 - x0, height = y1 - y0, pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) pixels.set(image.pixels.subarray(((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x1) * 4), y * width * 4);
  return { pixels, width, height };
}

/**
 * Camera Raw's preview: fit or any zoom, panned, rendering only what is on screen.
 *
 * Owner, docs/master-plan.md §58.1: the preview looked bad and could not be zoomed. It was one fixed
 * 640-pixel point-sampled render stretched by CSS. The open-source raw developers solve exactly
 * this: darktable's pixelpipe renders the visible region of interest at the display's scale (the
 * whole image at screen resolution when fitted, a crop at full resolution when zoomed in), and
 * RawTherapee's detail windows do the same for 100 % crops. Here the visible rectangle plus the
 * pipeline's own reach (`cameraRawRegionMargin`) is cropped, area-averaged to screen scale (never
 * above 1:1 — beyond that the canvas enlarges with hard pixel edges, like Photoshop), rendered in a
 * worker with its place in the image (`CameraRawFrame`) so the vignette and grain land where they
 * will on Apply, and a newer view or setting cancels the render in flight.
 *
 * Wheel zooms about the cursor, drag pans, double-click toggles Fit and 100 %.
 */
export function CameraRawViewport({ image, settings, language, postProcess, postProcessKey, onRenderingChange }: {
  image: CameraRawImage;
  settings: CameraRawFilterSettings;
  language: Language;
  postProcess?: CameraRawPostProcess | undefined;
  postProcessKey?: string;
  onRenderingChange?(rendering: boolean): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ mode: "fit" });
  const downsampleCache = useRef<{ key: string; value: CameraRawImage } | null>(null);
  const drag = useRef<{ x: number; y: number; centerX: number; centerY: number; scale: number } | null>(null);
  const t = (en: string, ru: string) => text(language, en, ru);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const deviceWidth = Math.max(1, Math.round(size.width * dpr)), deviceHeight = Math.max(1, Math.round(size.height * dpr));
  const fitScale = Math.min(deviceWidth / image.width, deviceHeight / image.height);
  const scale = view.mode === "fit" ? fitScale : view.scale;
  const centerX = view.mode === "fit" ? image.width / 2 : view.centerX, centerY = view.mode === "fit" ? image.height / 2 : view.centerY;

  useEffect(() => {
    if (!size.width || !size.height) return;
    const controller = new AbortController();
    const frame = requestAnimationFrame(() => {
      const visibleWidth = deviceWidth / scale, visibleHeight = deviceHeight / scale;
      const left = centerX - visibleWidth / 2, top = centerY - visibleHeight / 2;
      const x0 = Math.max(0, Math.floor(left)), y0 = Math.max(0, Math.floor(top));
      const x1 = Math.min(image.width, Math.ceil(left + visibleWidth)), y1 = Math.min(image.height, Math.ceil(top + visibleHeight));
      const canvas = canvasRef.current;
      if (!canvas || x1 <= x0 || y1 <= y0) return;
      const renderScale = Math.min(1, scale);
      const margin = Math.ceil(cameraRawRegionMargin(settings, renderScale) / renderScale);
      const mx0 = Math.max(0, x0 - margin), my0 = Math.max(0, y0 - margin), mx1 = Math.min(image.width, x1 + margin), my1 = Math.min(image.height, y1 + margin);
      const cacheKey = `${image.width}x${image.height}:${mx0},${my0},${mx1},${my1}@${renderScale}`;
      let input = downsampleCache.current?.key === cacheKey ? downsampleCache.current.value : null;
      if (!input) {
        const region = mx0 === 0 && my0 === 0 && mx1 === image.width && my1 === image.height ? image : crop(image, mx0, my0, mx1, my1);
        input = renderScale < 1 ? areaDownsample(region.pixels, region.width, region.height, renderScale) : region;
        downsampleCache.current = { key: cacheKey, value: input };
      }
      const toBufferX = input.width / (mx1 - mx0), toBufferY = input.height / (my1 - my0);
      onRenderingChange?.(true);
      void renderCameraRaw({ pixels: input.pixels, width: input.width, height: input.height, settings, frame: { imageWidth: image.width, imageHeight: image.height, offsetX: mx0 * toBufferX, offsetY: my0 * toBufferY, scale: toBufferX } }, controller.signal)
        .then((rendered) => postProcess ? postProcess(rendered, input!.width, input!.height, controller.signal) : rendered)
        .then((rendered) => {
          if (controller.signal.aborted) return;
          canvas.width = deviceWidth; canvas.height = deviceHeight;
          canvas.style.width = `${size.width}px`; canvas.style.height = `${size.height}px`;
          const context = canvas.getContext("2d");
          if (!context) return;
          const staging = document.createElement("canvas");
          staging.width = input!.width; staging.height = input!.height;
          staging.getContext("2d")!.putImageData(new ImageData(rendered as Uint8ClampedArray<ArrayBuffer>, input!.width, input!.height), 0, 0);
          context.clearRect(0, 0, deviceWidth, deviceHeight);
          // Past 100 % the pixels are shown as pixels, the way Photoshop and darktable enlarge.
          context.imageSmoothingEnabled = scale < 1;
          context.imageSmoothingQuality = "high";
          const sourceX = (x0 - mx0) * toBufferX, sourceY = (y0 - my0) * toBufferY;
          const sourceWidth = (x1 - x0) * toBufferX, sourceHeight = (y1 - y0) * toBufferY;
          context.drawImage(staging, sourceX, sourceY, sourceWidth, sourceHeight, (x0 - left) * scale, (y0 - top) * scale, (x1 - x0) * scale, (y1 - y0) * scale);
        })
        .catch((error: unknown) => { if (!(error instanceof Error && error.name === "AbortError")) console.warn("Camera Raw preview failed", error); })
        .finally(() => { if (!controller.signal.aborted) onRenderingChange?.(false); });
    });
    return () => { cancelAnimationFrame(frame); controller.abort(); };
  }, [image, settings, postProcess, postProcessKey, scale, centerX, centerY, deviceWidth, deviceHeight, size.width, size.height]);

  /** Zoom to `nextScale` keeping the image point under (clientX, clientY) where it is. */
  const zoomAt = (nextScale: number, clientX: number, clientY: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
    if (!bounds) { setView({ mode: "zoom", scale: clamped, centerX, centerY }); return; }
    const pointerX = (clientX - bounds.left) * dpr, pointerY = (clientY - bounds.top) * dpr;
    const imageX = centerX + (pointerX - deviceWidth / 2) / scale, imageY = centerY + (pointerY - deviceHeight / 2) / scale;
    setView({ mode: "zoom", scale: clamped, centerX: imageX - (pointerX - deviceWidth / 2) / clamped, centerY: imageY - (pointerY - deviceHeight / 2) / clamped });
  };

  // 100 % is one image pixel per physical screen pixel, as in Photoshop.
  const percent = Math.round(scale * 100);
  return <div className="camera-raw-viewport">
    <div
      ref={containerRef}
      className="camera-raw-viewport-stage"
      onWheel={(event) => { event.preventDefault(); zoomAt(scale * Math.pow(1.0015, -event.deltaY), event.clientX, event.clientY); }}
      onDoubleClick={(event) => { if (view.mode === "fit" || Math.abs(scale - 1) > 1e-6) zoomAt(1, event.clientX, event.clientY); else setView({ mode: "fit" }); }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, centerX, centerY, scale }; }}
      onPointerMove={(event) => { const start = drag.current; if (!start) return; setView({ mode: "zoom", scale: start.scale, centerX: start.centerX - (event.clientX - start.x) * dpr / start.scale, centerY: start.centerY - (event.clientY - start.y) * dpr / start.scale }); }}
      onPointerUp={() => { drag.current = null; }}
    >
      <canvas ref={canvasRef} />
    </div>
    <div className="camera-raw-viewport-bar">
      <button onClick={() => setView({ mode: "fit" })} className={view.mode === "fit" ? "active" : ""}>{t("Fit", "Вписать")}</button>
      <button onClick={() => setView({ mode: "zoom", scale: 1, centerX, centerY })}>100%</button>
      <button aria-label={t("Zoom out", "Уменьшить")} onClick={() => setView({ mode: "zoom", scale: Math.max(MIN_SCALE, scale / 1.5), centerX, centerY })}>−</button>
      <output>{percent}%</output>
      <button aria-label={t("Zoom in", "Увеличить")} onClick={() => setView({ mode: "zoom", scale: Math.min(MAX_SCALE, scale * 1.5), centerX, centerY })}>+</button>
    </div>
  </div>;
}
