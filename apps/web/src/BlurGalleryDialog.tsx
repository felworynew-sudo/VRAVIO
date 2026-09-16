import { useEffect, useMemo, useRef, useState } from "react";
import { fieldBlurEffect, irisBlurEffect, tiltShiftBlurEffect, spinBlurEffect, layerPixelsView, type RasterLayer } from "@vravio/env-raster";
import { text } from "./i18n";
import type { Language } from "./store";

type BlurGalleryType = "field" | "iris" | "tiltShift" | "spin";

const types: Array<[BlurGalleryType, string, string, string]> = [
  ["field", "Field Blur (Размытие поля)", "Field", "Поле"],
  ["iris", "Iris Blur (Размытие диафрагмы)", "Iris", "Диафр."],
  ["tiltShift", "Tilt-Shift (Наклон-смещение)", "Tilt", "Наклон"],
  ["spin", "Spin Blur (Размытие вращения)", "Spin", "Вращ."],
];

/**
 * docs/master-plan.md §51's interactivity level 3, one shared editor for all
 * of the Blur Gallery — modeled on `LiquifyDialog.tsx` (own canvas, own
 * pointer handling, no relation to `FilterGalleryDialog`), not a fifth
 * `FilterGalleryDialog` parameter set. A single pin at a time, matching
 * this component's v1 scope: real Photoshop supports several combined pins
 * per session (particularly Field/Iris), which this does not yet — see the
 * master plan for what is deliberately deferred. Path Blur is not offered
 * here at all: it needs a drawn multi-point path, a distinct interaction
 * primitive from a single draggable pin, not a fifth tab of this component.
 */
export function BlurGalleryDialog({ layer, initialType, onApply, onClose, language }: { layer: RasterLayer; initialType: BlurGalleryType; onApply(pixels: Uint8ClampedArray, label: string): void; onClose(): void; language: Language }) {
  const maxEdge = 640, scale = Math.min(1, maxEdge / Math.max(layer.width, layer.height));
  const displayWidth = Math.max(1, Math.round(layer.width * scale)), displayHeight = Math.max(1, Math.round(layer.height * scale));
  const [activeType, setActiveType] = useState<BlurGalleryType>(initialType);
  const [pin, setPin] = useState({ x: displayWidth / 2, y: displayHeight / 2 });
  const [blurRadius, setBlurRadius] = useState(15);
  const [innerRadius, setInnerRadius] = useState(40);
  const [outerRadius, setOuterRadius] = useState(90);
  const [focusDistance, setFocusDistance] = useState(40);
  const [featherDistance, setFeatherDistance] = useState(60);
  const [angle, setAngle] = useState(0);
  const [spinAmount, setSpinAmount] = useState(30);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<"pin" | "outerRing" | "featherHandle" | null>(null);

  const proxyPixels = useMemo(() => {
    const source0 = layerPixelsView(layer);
    if (displayWidth === layer.width && displayHeight === layer.height) return source0;
    const source = document.createElement("canvas"), target = document.createElement("canvas");
    source.width = layer.width; source.height = layer.height; target.width = displayWidth; target.height = displayHeight;
    source.getContext("2d")!.putImageData(new ImageData(source0 as Uint8ClampedArray<ArrayBuffer>, layer.width, layer.height), 0, 0);
    const context = target.getContext("2d")!; context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high"; context.drawImage(source, 0, 0, displayWidth, displayHeight);
    return context.getImageData(0, 0, displayWidth, displayHeight).data;
  }, [displayHeight, displayWidth, layer, layer.height, layer.pixelsRevision, layer.width]);

  // Preview radii are display-scale (the proxy canvas); Apply rescales every distance by 1/scale
  // so the full-resolution result matches what the preview showed, the same split Liquify's own
  // displayWidth/layer.width ratio makes between live drag and final render.
  const previewFor = (type: BlurGalleryType): Uint8ClampedArray => {
    if (type === "field") return fieldBlurEffect(proxyPixels, displayWidth, displayHeight, blurRadius * scale);
    if (type === "iris") return irisBlurEffect(proxyPixels, displayWidth, displayHeight, pin.x, pin.y, innerRadius, outerRadius, blurRadius * scale);
    if (type === "tiltShift") return tiltShiftBlurEffect(proxyPixels, displayWidth, displayHeight, pin.x, pin.y, angle, focusDistance, featherDistance, blurRadius * scale);
    return spinBlurEffect(proxyPixels, displayWidth, displayHeight, pin.x, pin.y, spinAmount);
  };

  const rendered = useMemo(() => previewFor(activeType), [activeType, proxyPixels, displayWidth, displayHeight, pin, blurRadius, innerRadius, outerRadius, focusDistance, featherDistance, angle, spinAmount, scale]);

  // A ref update (the canvas mounting) does not itself trigger a re-render, so painting inline
  // during render would miss the very first frame whenever the canvas element mounts after this
  // component's own first render — LiquifyDialog's own canvas draw is a useEffect for the same
  // reason, not an inline read of canvasRef.current.
  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (canvas && context) context.putImageData(new ImageData(rendered as Uint8ClampedArray<ArrayBuffer>, displayWidth, displayHeight), 0, 0);
  }, [rendered, displayWidth, displayHeight]);

  const toLocal = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * displayWidth / rect.width, y: (event.clientY - rect.top) * displayHeight / rect.height };
  };

  const onPinPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = "pin";
  };
  const onHandlePointerDown = (which: "outerRing" | "featherHandle") => (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = which;
  };
  const onStagePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const point = toLocal(event);
    if (dragRef.current === "pin") { setPin(point); return; }
    const distance = Math.hypot(point.x - pin.x, point.y - pin.y);
    if (dragRef.current === "outerRing") setOuterRadius(Math.max(innerRadius + 1, Math.round(distance)));
    else if (dragRef.current === "featherHandle") setFeatherDistance(Math.max(1, Math.round(distance - focusDistance)));
  };
  const onStagePointerUp = () => { dragRef.current = null; };

  const apply = () => {
    const source = layerPixelsView(layer);
    const centerX = pin.x / scale, centerY = pin.y / scale;
    let result: Uint8ClampedArray, label: string;
    if (activeType === "field") { result = fieldBlurEffect(source, layer.width, layer.height, blurRadius); label = "Field Blur (Размытие поля)"; }
    else if (activeType === "iris") { result = irisBlurEffect(source, layer.width, layer.height, centerX, centerY, innerRadius / scale, outerRadius / scale, blurRadius); label = "Iris Blur (Размытие диафрагмы)"; }
    else if (activeType === "tiltShift") { result = tiltShiftBlurEffect(source, layer.width, layer.height, centerX, centerY, angle, focusDistance / scale, featherDistance / scale, blurRadius); label = "Tilt-Shift (Наклон-смещение)"; }
    else { result = spinBlurEffect(source, layer.width, layer.height, centerX, centerY, spinAmount); label = "Spin Blur (Размытие вращения)"; }
    onApply(result, label);
    onClose();
  };

  return <div className="dialog-backdrop liquify-backdrop" onMouseDown={onClose}>
    <section className="liquify-dialog blur-gallery-dialog" role="dialog" aria-modal="true" aria-label="Blur Gallery (Галерея размытия)" onMouseDown={(event) => event.stopPropagation()}>
      <header><strong>Blur Gallery (Галерея размытия)</strong><button onClick={onClose}>×</button></header>
      <div className="liquify-body blur-gallery-body">
        <aside className="liquify-tools blur-gallery-tools">{types.map(([id, fullLabel, shortEn, shortRu]) => <button key={id} className={activeType === id ? "active" : ""} title={fullLabel} aria-label={fullLabel} onClick={() => setActiveType(id)}>{text(language, shortEn, shortRu)}</button>)}</aside>
        <main className="liquify-canvas-wrap">
          <div className="liquify-canvas-stage" style={{ width: displayWidth, height: displayHeight }} onPointerMove={onStagePointerMove} onPointerUp={onStagePointerUp} onPointerCancel={onStagePointerUp}>
            <canvas ref={canvasRef} width={displayWidth} height={displayHeight}/>
            <svg className="blur-gallery-overlay" width={displayWidth} height={displayHeight} viewBox={`0 0 ${displayWidth} ${displayHeight}`}>
              {activeType === "iris" && <ellipse cx={pin.x} cy={pin.y} rx={innerRadius} ry={innerRadius} className="blur-gallery-ring blur-gallery-ring-inner"/>}
              {activeType === "iris" && <ellipse cx={pin.x} cy={pin.y} rx={outerRadius} ry={outerRadius} className="blur-gallery-ring blur-gallery-ring-outer"/>}
              {activeType === "tiltShift" && (() => {
                const rad = angle * Math.PI / 180, nx = -Math.sin(rad), ny = Math.cos(rad), dx = Math.cos(rad), dy = Math.sin(rad), span = Math.max(displayWidth, displayHeight);
                const lineAt = (offset: number) => ({ x1: pin.x + nx * offset - dx * span, y1: pin.y + ny * offset - dy * span, x2: pin.x + nx * offset + dx * span, y2: pin.y + ny * offset + dy * span });
                const focusLine1 = lineAt(focusDistance), focusLine2 = lineAt(-focusDistance), featherLine1 = lineAt(focusDistance + featherDistance), featherLine2 = lineAt(-focusDistance - featherDistance);
                return <>
                  <line {...focusLine1} className="blur-gallery-ring"/>
                  <line {...focusLine2} className="blur-gallery-ring"/>
                  <line {...featherLine1} className="blur-gallery-ring blur-gallery-ring-outer"/>
                  <line {...featherLine2} className="blur-gallery-ring blur-gallery-ring-outer"/>
                </>;
              })()}
            </svg>
            <div className="blur-gallery-pin" style={{ left: pin.x, top: pin.y }} onPointerDown={onPinPointerDown} title={text(language, "Drag to move", "Перетащите, чтобы переместить")}/>
            {activeType === "iris" && <div className="blur-gallery-handle" style={{ left: pin.x + outerRadius, top: pin.y }} onPointerDown={onHandlePointerDown("outerRing")} title={text(language, "Drag to resize the outer ring", "Перетащите, чтобы изменить внешнее кольцо")}/>}
            {activeType === "tiltShift" && <div className="blur-gallery-handle" style={{ left: pin.x, top: pin.y - focusDistance - featherDistance }} onPointerDown={onHandlePointerDown("featherHandle")} title={text(language, "Drag to set the feather distance", "Перетащите, чтобы задать растушёвку")}/>}
          </div>
        </main>
        <aside className="liquify-settings">
          <label>{text(language, "Blur", "Размытие")}<input type="range" min={0} max={32} value={blurRadius} onChange={(event) => setBlurRadius(event.target.valueAsNumber)}/><output>{blurRadius}px</output></label>
          {activeType === "iris" && <label>{text(language, "Inner radius", "Внутренний радиус")}<input type="range" min={1} max={Math.max(2, outerRadius - 1)} value={innerRadius} onChange={(event) => setInnerRadius(Math.min(outerRadius - 1, event.target.valueAsNumber))}/><output>{innerRadius}px</output></label>}
          {activeType === "iris" && <label>{text(language, "Outer radius", "Внешний радиус")}<input type="range" min={innerRadius + 1} max={Math.max(displayWidth, displayHeight)} value={outerRadius} onChange={(event) => setOuterRadius(event.target.valueAsNumber)}/><output>{outerRadius}px</output></label>}
          {activeType === "tiltShift" && <label>{text(language, "Focus distance", "Расстояние фокуса")}<input type="range" min={0} max={Math.max(displayWidth, displayHeight) / 2} value={focusDistance} onChange={(event) => setFocusDistance(event.target.valueAsNumber)}/><output>{focusDistance}px</output></label>}
          {activeType === "tiltShift" && <label>{text(language, "Feather distance", "Растушёвка")}<input type="range" min={1} max={Math.max(displayWidth, displayHeight) / 2} value={featherDistance} onChange={(event) => setFeatherDistance(event.target.valueAsNumber)}/><output>{featherDistance}px</output></label>}
          {activeType === "tiltShift" && <label>{text(language, "Angle", "Угол")}<input type="range" min={-90} max={90} value={angle} onChange={(event) => setAngle(event.target.valueAsNumber)}/><output>{angle}°</output></label>}
          {activeType === "spin" && <label>{text(language, "Amount", "Сила")}<input type="range" min={1} max={100} value={spinAmount} onChange={(event) => setSpinAmount(event.target.valueAsNumber)}/><output>{spinAmount}%</output></label>}
          <p className="blur-gallery-hint">{text(language, "Drag the pin to reposition. One effect at a time — switching tabs replaces the current pin.", "Перетащите булавку, чтобы переместить. Один эффект за раз — переключение вкладки заменяет текущую булавку.")}</p>
        </aside>
      </div>
      <footer><button onClick={onClose}>{text(language, "Cancel", "Отмена")}</button><button className="primary" onClick={apply}>{text(language, "Apply", "Применить")}</button></footer>
    </section>
  </div>;
}
