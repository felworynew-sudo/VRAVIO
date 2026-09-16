import { useEffect, useMemo, useRef, useState } from "react";
import { displaceEffect, layerPixelsView, type RasterLayer } from "@vravio/env-raster";
import { decodeImportedImage } from "./imageImport";
import { text } from "./i18n";
import type { Language } from "./store";

/** Draws a decoded image onto a `width`×`height` canvas — "Stretch To Fit" scales it to cover
 * the whole area (Photoshop's own default), "Tile" repeats it at its own native size, matching
 * the real Displace dialog's own two choices for a map that doesn't already match the layer. */
function rasterizeMap(image: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, tile: boolean): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  if (tile) {
    const pattern = context.createPattern(image, "repeat")!;
    context.fillStyle = pattern;
    context.fillRect(0, 0, width, height);
  } else {
    context.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
  }
  return context.getImageData(0, 0, width, height).data as unknown as Uint8ClampedArray;
}

/**
 * Displace — Photoshop's own Distort filter that reads a second image's
 * luminance as a per-pixel offset map (docs/master-plan.md §51). The one
 * filter in this menu that needs an external file, so it gets its own small
 * dialog rather than a `FilterGalleryDialog` entry, which has no concept of
 * a second image input.
 */
export function DisplaceDialog({ layer, onApply, onClose, language }: { layer: RasterLayer; onApply(pixels: Uint8ClampedArray, label: string): void; onClose(): void; language: Language }) {
  const maxEdge = 640, scale = Math.min(1, maxEdge / Math.max(layer.width, layer.height));
  const displayWidth = Math.max(1, Math.round(layer.width * scale)), displayHeight = Math.max(1, Math.round(layer.height * scale));
  const [horizontalScale, setHorizontalScale] = useState(10);
  const [verticalScale, setVerticalScale] = useState(10);
  const [tile, setTile] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [mapImage, setMapImage] = useState<{ image: CanvasImageSource; width: number; height: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const proxySource = useMemo(() => {
    const source0 = layerPixelsView(layer);
    if (displayWidth === layer.width && displayHeight === layer.height) return source0;
    const source = document.createElement("canvas"), target = document.createElement("canvas");
    source.width = layer.width; source.height = layer.height; target.width = displayWidth; target.height = displayHeight;
    source.getContext("2d")!.putImageData(new ImageData(source0 as Uint8ClampedArray<ArrayBuffer>, layer.width, layer.height), 0, 0);
    const context = target.getContext("2d")!; context.imageSmoothingEnabled = true; context.drawImage(source, 0, 0, displayWidth, displayHeight);
    return context.getImageData(0, 0, displayWidth, displayHeight).data as unknown as Uint8ClampedArray;
  }, [displayWidth, displayHeight, layer, layer.pixelsRevision, layer.width, layer.height]);

  const proxyMap = useMemo(() => mapImage ? rasterizeMap(mapImage.image, mapImage.width, mapImage.height, displayWidth, displayHeight, tile) : null, [mapImage, displayWidth, displayHeight, tile]);

  const rendered = useMemo(() => proxyMap ? displaceEffect(proxySource, displayWidth, displayHeight, proxyMap, horizontalScale * scale, verticalScale * scale, wrap) : proxySource, [proxyMap, proxySource, displayWidth, displayHeight, horizontalScale, verticalScale, wrap, scale]);

  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (canvas && context) context.putImageData(new ImageData(rendered as Uint8ClampedArray<ArrayBuffer>, displayWidth, displayHeight), 0, 0);
  }, [rendered, displayWidth, displayHeight]);

  const chooseFile = async (file: File) => {
    setError(null);
    const decoded = await decodeImportedImage(file);
    if (!decoded) { setError(text(language, "Could not read that image", "Не удалось прочитать это изображение")); return; }
    setMapImage({ image: decoded.image, width: decoded.width, height: decoded.height, name: file.name });
  };

  const apply = () => {
    if (!mapImage) return;
    const source = layerPixelsView(layer);
    const fullMap = rasterizeMap(mapImage.image, mapImage.width, mapImage.height, layer.width, layer.height, tile);
    const result = displaceEffect(source, layer.width, layer.height, fullMap, horizontalScale, verticalScale, wrap);
    onApply(result, "Displace (Смещение)");
    onClose();
  };

  return <div className="dialog-backdrop liquify-backdrop" onMouseDown={onClose}>
    <section className="liquify-dialog displace-dialog" role="dialog" aria-modal="true" aria-label="Displace (Смещение)" onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>Displace (Смещение)</strong><button onClick={onClose}>×</button></header>
      <div className="liquify-body displace-body">
        <main className="liquify-canvas-wrap">
          <div className="liquify-canvas-stage" style={{ width: displayWidth, height: displayHeight }}>
            <canvas ref={canvasRef} width={displayWidth} height={displayHeight}/>
          </div>
        </main>
        <aside className="liquify-settings">
          <button onClick={() => fileRef.current?.click()}>{text(language, "Choose displacement map…", "Выбрать карту смещения…")}</button>
          {mapImage && <small>{mapImage.name}</small>}
          {error && <small className="filter-render-error">{error}</small>}
          <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void chooseFile(file); event.currentTarget.value = ""; }}/>
          <label>{text(language, "Horizontal scale", "Масштаб по горизонтали")}<input type="range" min={-100} max={100} value={horizontalScale} onChange={(event) => setHorizontalScale(event.target.valueAsNumber)}/><output>{horizontalScale}</output></label>
          <label>{text(language, "Vertical scale", "Масштаб по вертикали")}<input type="range" min={-100} max={100} value={verticalScale} onChange={(event) => setVerticalScale(event.target.valueAsNumber)}/><output>{verticalScale}</output></label>
          <label className="liquify-check"><input type="checkbox" checked={tile} onChange={(event) => setTile(event.target.checked)}/>{text(language, "Tile map", "Заполнить плиткой")}</label>
          <label className="liquify-check"><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)}/>{text(language, "Wrap around edges", "Зациклить края")}</label>
          <p className="blur-gallery-hint">{text(language, "Choose an image to use as a displacement map — its brightness pushes pixels away from grey, toward white or black.", "Выберите изображение как карту смещения — её яркость сдвигает пиксели от серого к белому или чёрному.")}</p>
        </aside>
      </div>
      <footer><button onClick={onClose}>{text(language, "Cancel", "Отмена")}</button><button className="primary" disabled={!mapImage} onClick={apply}>{text(language, "Apply", "Применить")}</button></footer>
    </section>
  </div>;
}
