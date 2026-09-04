import { useEffect, useState, type RefObject } from "react";
import type { RasterDocumentState, RasterGuide } from "@vravio/env-raster";
import { pointFromNativeEvent, rulerStep } from "./raster-coordinates";
import { kernel } from "./kernel";
import type { DocumentViewport } from "./store";

/**
 * The ruler bars and draggable guide lines — split out of `RasterWorkspace.tsx`
 * purely to bring its own line count down (docs/migration-plan.md §8), not
 * because any of this changed.
 *
 * A hook, not a component: the guide overlay SVG has to sit *inside*
 * `.raster-stage` (it shares that element's pan/zoom/rotate transform, the
 * same as the tool Overlay and the selection outline), while the ruler bars
 * have to sit *outside* it (screen-space chrome, unscaled) — two DOM
 * locations in the host's own render tree. Returning `{ guideOverlay, rulers }`
 * for the host to place keeps `guideDraft` a single piece of state shared by
 * both, rather than two component instances each getting their own copy —
 * caught live: an earlier version of this split called the same component
 * twice, and a guide dragged out of the ruler updated a `guideDraft` the
 * overlay component never saw, so the drag showed no live preview at all.
 */
export function useRasterRulerGuides(params: {
  documentId: string;
  state: RasterDocumentState;
  viewport: DocumentViewport;
  workspaceRef: RefObject<HTMLDivElement | null>;
  workspaceSize: { width: number; height: number };
  documentOriginX: number;
  documentOriginY: number;
}) {
  const { documentId, state, viewport, workspaceRef, workspaceSize, documentOriginX, documentOriginY } = params;
  const [guideDraft, setGuideDraft] = useState<RasterGuide | null>(null);

  // Image ▸ Clear Guides has no canvas gesture of its own to hang a handler
  // off, so it reaches this hook the same way raster.move's Ctrl+T does its
  // tool — a window event the piece that owns the relevant state listens for.
  useEffect(() => {
    const clear = () => kernel.documents.update<RasterDocumentState>(documentId, (current) => { current.guides = []; });
    window.addEventListener("vravio-guides-clear", clear);
    return () => window.removeEventListener("vravio-guides-clear", clear);
  }, [documentId]);

  const guidePointer = (event: React.PointerEvent<HTMLDivElement>, orientation: RasterGuide["orientation"], finish = false) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const point = pointFromNativeEvent(workspace, viewport, state.width, state.height, event.nativeEvent), position = orientation === "vertical" ? point.x : point.y;
    const next = { orientation, position } satisfies RasterGuide;
    if (!finish) { event.currentTarget.setPointerCapture(event.pointerId); setGuideDraft(next); return; }
    setGuideDraft(null);
    const limit = orientation === "vertical" ? state.width : state.height;
    if (position < 0 || position > limit) return;
    kernel.documents.update<RasterDocumentState>(documentId, (current) => { (current.guides ??= []).push(next); });
  };

  const step = rulerStep(viewport.zoom);
  const horizontalTicks: number[] = [], verticalTicks: number[] = [];
  for (let value = Math.floor(-documentOriginX / (step * viewport.zoom)) * step; value * viewport.zoom + documentOriginX < workspaceSize.width; value += step) horizontalTicks.push(value);
  for (let value = Math.floor(-documentOriginY / (step * viewport.zoom)) * step; value * viewport.zoom + documentOriginY < workspaceSize.height; value += step) verticalTicks.push(value);
  const guides = state.guides ?? [];

  const guideOverlay = <svg className="guide-overlay" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true">
    {[...guides, ...(guideDraft ? [guideDraft] : [])].map((guide, index) => guide.orientation === "vertical"
      ? <line key={`${guide.orientation}-${index}`} x1={guide.position} y1="0" x2={guide.position} y2={state.height}/>
      : <line key={`${guide.orientation}-${index}`} x1="0" y1={guide.position} x2={state.width} y2={guide.position}/>)}
  </svg>;

  const rulers = <div className="rulers" aria-hidden="true">
    <div className="ruler-corner"/>
    <div className="ruler-horizontal" onPointerDown={(event) => guidePointer(event, "horizontal")} onPointerMove={(event) => { if (guideDraft?.orientation === "horizontal") guidePointer(event, "horizontal"); }} onPointerUp={(event) => guidePointer(event, "horizontal", true)}>
      {horizontalTicks.map((value) => <i key={value} style={{ left: value * viewport.zoom + documentOriginX }}><span>{Math.round(value)}</span></i>)}
    </div>
    <div className="ruler-vertical" onPointerDown={(event) => guidePointer(event, "vertical")} onPointerMove={(event) => { if (guideDraft?.orientation === "vertical") guidePointer(event, "vertical"); }} onPointerUp={(event) => guidePointer(event, "vertical", true)}>
      {verticalTicks.map((value) => <i key={value} style={{ top: value * viewport.zoom + documentOriginY }}><span>{Math.round(value)}</span></i>)}
    </div>
  </div>;

  return { guideOverlay, rulers };
}
