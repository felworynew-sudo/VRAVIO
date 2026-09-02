import { useEffect, useMemo, useRef, useState } from "react";
import { createLiquifyState, isLiquifyIdentity, liquifyFreeze, liquifyPuckerBloat, liquifyReconstruct, liquifySmooth, liquifyTwirl, liquifyWarp, renderLiquify, type LiquifyState, type LiquifyTool, type RasterLayer } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";

const tools: Array<[LiquifyTool, string, string]> = [
  ["warp", "ДЕФОРМАЦИЯ.svg", "Warp (Деформация)"],
  ["twirl", "ВИХРЬ.svg", "Twirl (Вихрь)"],
  ["pucker", "СЖАТИЕ.svg", "Pucker (Сжатие)"],
  ["bloat", "РАЗДУТИЕ.svg", "Bloat (Раздутие)"],
  ["smooth", "СГЛАЖИВАНИЕ.svg", "Smooth (Сглаживание)"],
  ["reconstruct", "ВОССТАНОВЛЕНИЕ.svg", "Reconstruct (Восстановление)"],
  ["freeze", "ЗАМОРОЗИТЬ.svg", "Freeze mask (Заморозить)"],
  ["thaw", "РАЗМОРОЗИТЬ.svg", "Thaw mask (Разморозить)"],
];

export function LiquifyDialog({ layer, onApply, onClose, language }: { layer: RasterLayer; onApply(pixels: Uint8ClampedArray, label: string): void; onClose(): void; language: Language }) {
  const maxEdge = 640, scale = Math.min(1, maxEdge / Math.max(layer.width, layer.height));
  const displayWidth = Math.max(1, Math.round(layer.width * scale)), displayHeight = Math.max(1, Math.round(layer.height * scale));
  const [tool, setTool] = useState<LiquifyTool>("warp");
  const [brushSize, setBrushSize] = useState(80);
  const [pressure, setPressure] = useState(50);
  const [density, setDensity] = useState(50);
  const [showFreezeMask, setShowFreezeMask] = useState(true);
  const [version, setVersion] = useState(0);
  const stateRef = useRef<LiquifyState>(createLiquifyState(displayWidth, displayHeight));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const proxyPixels = useMemo(() => {
    if (displayWidth === layer.width && displayHeight === layer.height) return layer.pixels;
    const source = document.createElement("canvas"), target = document.createElement("canvas");
    source.width = layer.width; source.height = layer.height; target.width = displayWidth; target.height = displayHeight;
    source.getContext("2d")!.putImageData(new ImageData(layer.pixels as Uint8ClampedArray<ArrayBuffer>, layer.width, layer.height), 0, 0);
    const context = target.getContext("2d")!; context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high"; context.drawImage(source, 0, 0, displayWidth, displayHeight);
    return context.getImageData(0, 0, displayWidth, displayHeight).data;
  }, [displayHeight, displayWidth, layer.height, layer.pixels, layer.width]);

  useEffect(() => { stateRef.current = createLiquifyState(displayWidth, displayHeight); setVersion((value) => value + 1); }, [displayHeight, displayWidth, layer.id]);

  const scheduleRender = () => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; setVersion((value) => value + 1); });
  };

  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const rendered = renderLiquify(proxyPixels, displayWidth, displayHeight, stateRef.current);
    const source = document.createElement("canvas");
    source.width = displayWidth; source.height = displayHeight;
    source.getContext("2d")!.putImageData(new ImageData(rendered as Uint8ClampedArray<ArrayBuffer>, displayWidth, displayHeight), 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (showFreezeMask) {
      const freeze = stateRef.current.freeze, maskCanvas = document.createElement("canvas");
      maskCanvas.width = stateRef.current.width; maskCanvas.height = stateRef.current.height;
      const maskContext = maskCanvas.getContext("2d")!, maskImage = maskContext.createImageData(stateRef.current.width, stateRef.current.height);
      for (let index = 0; index < freeze.length; index += 1) { const alpha = freeze[index]!; maskImage.data[index * 4] = 60; maskImage.data[index * 4 + 1] = 130; maskImage.data[index * 4 + 2] = 255; maskImage.data[index * 4 + 3] = Math.round(alpha * 0.55); }
      maskContext.putImageData(maskImage, 0, 0);
      context.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
    }
  }, [version, proxyPixels, displayHeight, displayWidth, showFreezeMask]);

  const toLayerCoords = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * stateRef.current.width / rect.width, y: (event.clientY - rect.top) * stateRef.current.height / rect.height };
  };

  const applyStroke = (x: number, y: number, previous: { x: number; y: number } | null) => {
    const state = stateRef.current, radius = Math.max(2, brushSize * scale / 2), strength = pressure / 100, brushDensity = density / 100;
    switch (tool) {
      case "warp": if (previous) liquifyWarp(state, x, y, x - previous.x, y - previous.y, radius, strength, brushDensity); break;
      case "twirl": liquifyTwirl(state, x, y, radius, strength, brushDensity); break;
      case "pucker": liquifyPuckerBloat(state, x, y, radius, strength, 1, brushDensity); break;
      case "bloat": liquifyPuckerBloat(state, x, y, radius, strength, -1, brushDensity); break;
      case "smooth": liquifySmooth(state, x, y, radius, strength, brushDensity); break;
      case "reconstruct": liquifyReconstruct(state, x, y, radius, strength, brushDensity); break;
      case "freeze": liquifyFreeze(state, x, y, radius, false, strength, brushDensity); break;
      case "thaw": liquifyFreeze(state, x, y, radius, true, strength, brushDensity); break;
    }
  };

  const moveCursor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(), cursor = cursorRef.current;
    if (cursor) cursor.style.transform = `translate(${event.clientX - rect.left - brushPreviewSize / 2}px, ${event.clientY - rect.top - brushPreviewSize / 2}px)`;
  };
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toLayerCoords(event);
    applyStroke(point.x, point.y, null);
    dragRef.current = point;
    moveCursor(event);
    scheduleRender();
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    moveCursor(event);
    if (!dragRef.current) return;
    const point = toLayerCoords(event), previous = dragRef.current;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y), spacing = Math.max(1, brushSize * scale * 0.1), steps = Math.max(1, Math.ceil(distance / spacing));
    let from = previous;
    for (let step = 1; step <= steps; step += 1) { const t = step / steps, sample = { x: previous.x + (point.x - previous.x) * t, y: previous.y + (point.y - previous.y) * t }; applyStroke(sample.x, sample.y, from); from = sample; }
    dragRef.current = point;
    scheduleRender();
  };
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); dragRef.current = null; };

  const restoreAll = () => { stateRef.current = createLiquifyState(displayWidth, displayHeight); setVersion((value) => value + 1); };
  const apply = () => {
    if (isLiquifyIdentity(stateRef.current)) { onClose(); return; }
    onApply(renderLiquify(layer.pixels, layer.width, layer.height, stateRef.current), "Liquify (Пластика)");
    onClose();
  };

  const brushPreviewSize = useMemo(() => Math.max(6, Math.round(brushSize * scale)), [brushSize, scale]);

  return <div className="dialog-backdrop liquify-backdrop" onMouseDown={onClose}>
    <section className="liquify-dialog" role="dialog" aria-modal="true" aria-label="Liquify (Пластика)" onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>Liquify (Пластика)</strong><button onClick={onClose}>×</button></header>
      <div className="liquify-body">
        <aside className="liquify-tools">{tools.map(([id, iconFile, label]) => <button key={id} className={tool === id ? "active" : ""} title={label} aria-label={label} onClick={() => setTool(id)}><img className="liquify-glyph" src={`/${iconFile}`} alt=""/></button>)}</aside>
        <main className="liquify-canvas-wrap">
          <div className="liquify-canvas-stage" style={{ width: displayWidth, height: displayHeight }}>
            <canvas ref={canvasRef} width={displayWidth} height={displayHeight} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} style={{ cursor: "none" }}/>
            <div ref={cursorRef} className="liquify-brush-cursor" style={{ width: brushPreviewSize, height: brushPreviewSize }}/>
          </div>
        </main>
        <aside className="liquify-settings">
          <label>{text(language, "Brush size", "Размер кисти")}<input type="range" min={5} max={Math.max(20, Math.max(layer.width, layer.height))} value={brushSize} onChange={(event) => setBrushSize(event.target.valueAsNumber)}/><output>{brushSize}px</output></label>
          <label>{text(language, "Pressure", "Нажим")}<input type="range" min={1} max={100} value={pressure} onChange={(event) => setPressure(event.target.valueAsNumber)}/><output>{pressure}%</output></label>
          <label>{text(language, "Density", "Плотность")}<input type="range" min={1} max={100} value={density} onChange={(event) => setDensity(event.target.valueAsNumber)}/><output>{density}%</output></label>
          <label className="liquify-check"><input type="checkbox" checked={showFreezeMask} onChange={(event) => setShowFreezeMask(event.target.checked)}/>{text(language, "Show freeze mask", "Показывать маску заморозки")}</label>
          <button onClick={restoreAll}>{text(language, "Restore All", "Восстановить всё")}</button>
        </aside>
      </div>
      <footer><button onClick={onClose}>{text(language, "Cancel", "Отмена")}</button><button className="primary" onClick={apply}>{text(language, "Apply", "Применить")}</button></footer>
    </section>
  </div>;
}
