import { useEffect, useRef, useState } from "react";
import { compositeRasterThumbnail, isRasterDocumentState } from "@vravio/env-raster";
import { kernel } from "./kernel";
import { defaultViewport, useShellStore } from "./store";
import { useDocuments } from "./useDocuments";
import { text } from "./i18n";

export interface ViewportMetrics { documentId: string; workspaceWidth: number; workspaceHeight: number }

const THUMBNAIL_MAX = 240;

export function NavigatorPanel() {
  const language = useShellStore((state) => state.language);
  const activeDocumentId = useShellStore((state) => state.activeDocumentId);
  const documents = useDocuments();
  const setViewport = useShellStore((state) => state.setViewport);
  const viewport = useShellStore((state) => (activeDocumentId ? state.viewports[activeDocumentId] : undefined) ?? defaultViewport);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [metrics, setMetrics] = useState<ViewportMetrics | null>(null);
  const active = documents.find((item) => item.id === activeDocumentId) ?? null;
  const state = active && isRasterDocumentState(active.state) ? active.state : null;

  useEffect(() => {
    const onMetrics = (event: Event) => setMetrics((event as CustomEvent<ViewportMetrics>).detail);
    window.addEventListener("vravio-viewport-metrics", onMetrics);
    window.dispatchEvent(new Event("vravio-viewport-metrics-request"));
    return () => window.removeEventListener("vravio-viewport-metrics", onMetrics);
  }, []);

  // Compositing for the thumbnail is expensive and never urgent, so it waits for an idle
  // slot (spec §9.2) and is skipped entirely while the user is mid-gesture.
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    const draw = () => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (cancelled || !canvas || !context || !state) return;
      const thumbnail = compositeRasterThumbnail(state, THUMBNAIL_MAX);
      canvas.width = thumbnail.width;
      canvas.height = thumbnail.height;
      context.putImageData(new ImageData(thumbnail.pixels as Uint8ClampedArray<ArrayBuffer>, thumbnail.width, thumbnail.height), 0, 0);
    };
    const idle = globalThis.requestIdleCallback?.(draw, { timeout: 600 }) ?? globalThis.setTimeout(draw, 120);
    return () => {
      cancelled = true;
      if (globalThis.cancelIdleCallback && typeof idle === "number") globalThis.cancelIdleCallback(idle);
      clearTimeout(idle as ReturnType<typeof setTimeout>);
    };
  }, [state, active?.revision]);

  if (!active || !state) return <div className="dock-panel-body"><div className="empty-row">{text(language, "No document", "Нет документа")}</div></div>;

  const thumbScale = Math.min(THUMBNAIL_MAX / state.width, THUMBNAIL_MAX / state.height);
  const thumbWidth = Math.max(1, Math.round(state.width * thumbScale)), thumbHeight = Math.max(1, Math.round(state.height * thumbScale));
  // The workspace centres the document, so pan offsets the centre; convert that into the
  // visible rectangle in document space and then into thumbnail space.
  const visibleWidth = (metrics?.workspaceWidth ?? 0) / viewport.zoom, visibleHeight = (metrics?.workspaceHeight ?? 0) / viewport.zoom;
  const centreX = state.width / 2 - viewport.panX / viewport.zoom, centreY = state.height / 2 - viewport.panY / viewport.zoom;
  const frame = metrics ? {
    left: (centreX - visibleWidth / 2) * thumbScale,
    top: (centreY - visibleHeight / 2) * thumbScale,
    width: visibleWidth * thumbScale,
    height: visibleHeight * thumbScale,
  } : null;

  const panTo = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const documentX = (event.clientX - rect.left) / thumbScale, documentY = (event.clientY - rect.top) / thumbScale;
    setViewport(active.id, { mode: "custom", panX: (state.width / 2 - documentX) * viewport.zoom, panY: (state.height / 2 - documentY) * viewport.zoom });
  };

  return <div className="dock-panel-body navigator-panel">
    <div className="navigator-stage" style={{ width: thumbWidth, height: thumbHeight }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); panTo(event); }} onPointerMove={panTo}>
      <canvas ref={canvasRef} />
      {frame && <i className="navigator-frame" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }} />}
    </div>
    <label className="navigator-zoom">
      <input type="range" min={1} max={400} value={Math.round(viewport.zoom * 100)} onChange={(event) => setViewport(active.id, { mode: "custom", zoom: Math.max(.01, event.target.valueAsNumber / 100) })} />
      <input type="number" min={1} max={6400} value={Math.round(viewport.zoom * 100)} onChange={(event) => setViewport(active.id, { mode: "custom", zoom: Math.max(.01, (event.target.valueAsNumber || 100) / 100) })} />
      <span>%</span>
    </label>
    <div className="navigator-actions">
      <button onClick={() => void kernel.commands.execute("view.fit", { activeDocumentId: active.id })}>{text(language, "Fit", "Вписать")}</button>
      <button onClick={() => void kernel.commands.execute("view.actual", { activeDocumentId: active.id })}>100%</button>
    </div>
  </div>;
}
