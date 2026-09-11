import { useEffect, useState, type RefObject } from "react";
import type { RasterDocumentState, RasterGuide } from "@vravio/env-raster";
import { pointFromNativeEvent, rulerLocalPosition, rulerStep } from "./raster-coordinates";
import { kernel } from "./kernel";
import type { DocumentViewport } from "./store";
import { useShellStore, type RulerUnit } from "./store";

/**
 * The ruler bars and draggable guide lines — split out of `RasterWorkspace.tsx`
 * purely to bring its own line count down (docs/migration-plan.md §8), not
 * because any of this changed.
 *
 * A hook, not a component: the guide overlay and the ruler bars both have to
 * sit *outside* `.raster-stage` — screen-space chrome, unscaled, the same
 * place `RasterWorkspace.tsx`'s own brush-cursor overlay lives and for the
 * documented reason its comment gives: `.raster-stage` carries the zoom's
 * CSS scale transform, and `vector-effect:non-scaling-stroke` does not
 * reliably cancel a *CSS* transform on an ancestor the way it cancels an
 * SVG viewBox/internal transform — a guide line's `stroke-width:1` was
 * measurably scaling with zoom despite asking it not to (a guide looked
 * several pixels thick at 400% zoom). Guide lines used to live inside
 * `.raster-stage`, positioned via the SVG's own `viewBox`; they're
 * positioned here the same way the ruler ticks already are —
 * `value * viewport.zoom + documentOriginX/Y`, real screen pixels, so a
 * guide's *position* still tracks pan/zoom exactly while its *line weight*
 * stays a literal, un-transformed CSS pixel. Returning
 * `{ guideOverlay, rulers }` for the host to place keeps `guideDraft` a
 * single piece of state shared by both, rather than two component
 * instances each getting their own copy — caught live: an earlier version
 * of this split called the same component twice, and a guide dragged out
 * of the ruler updated a `guideDraft` the overlay component never saw, so
 * the drag showed no live preview at all.
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
  const [unitMenu, setUnitMenu] = useState<{ x: number; y: number } | null>(null);
  const rulerUnit = useShellStore((shell) => shell.preferences.rulerUnit);
  const updatePreferences = useShellStore((shell) => shell.updatePreferences);
  const ppi = state.resolutionUnit === "ppcm" ? state.resolution * 2.54 : state.resolution;
  const formatTick = (pixels: number) => {
    if (rulerUnit === "px" || !Number.isFinite(ppi) || ppi <= 0) return `${Math.round(pixels)}`;
    const value = rulerUnit === "in" ? pixels / ppi : rulerUnit === "mm" ? pixels / ppi * 25.4 : pixels / ppi * 2.54;
    return `${Math.round(value * 100) / 100}`;
  };
  const openUnitMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const workspace = workspaceRef.current?.getBoundingClientRect();
    if (!workspace) return;
    setUnitMenu({ x: event.clientX - workspace.left, y: event.clientY - workspace.top });
  };

  // Image ▸ Clear Guides has no canvas gesture of its own to hang a handler
  // off, so it reaches this hook the same way raster.move's Ctrl+T does its
  // tool — a window event the piece that owns the relevant state listens for.
  useEffect(() => {
    const clear = () => kernel.documents.update<RasterDocumentState>(documentId, (current) => { current.guides = []; });
    window.addEventListener("vravio-guides-clear", clear);
    return () => window.removeEventListener("vravio-guides-clear", clear);
  }, [documentId]);

  // A context menu should behave like a native menu: selecting an entry or
  // clicking anywhere else closes it. Keeping this separate from pointer
  // capture also prevents a right-click from beginning a guide drag.
  useEffect(() => {
    if (!unitMenu) return;
    const close = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest(".ruler-unit-menu")) return;
      setUnitMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [unitMenu]);

  const guidePointer = (event: React.PointerEvent<HTMLDivElement>, orientation: RasterGuide["orientation"], finish = false) => {
    if (event.button !== 0) return;
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

  const guideOverlay = <svg className="guide-overlay" width={workspaceSize.width} height={workspaceSize.height} aria-hidden="true">
    {[...guides, ...(guideDraft ? [guideDraft] : [])].map((guide, index) => guide.orientation === "vertical"
      ? <line key={`${guide.orientation}-${index}`} x1={guide.position * viewport.zoom + documentOriginX} y1={0} x2={guide.position * viewport.zoom + documentOriginX} y2={workspaceSize.height}/>
      : <line key={`${guide.orientation}-${index}`} x1={0} y1={guide.position * viewport.zoom + documentOriginY} x2={workspaceSize.width} y2={guide.position * viewport.zoom + documentOriginY}/>)}
  </svg>;

  const rulers = <div className="rulers" aria-hidden="true">
    <div className="ruler-corner"/>
    <div className="ruler-horizontal" onContextMenu={openUnitMenu} onPointerDown={(event) => guidePointer(event, "horizontal")} onPointerMove={(event) => { if (guideDraft?.orientation === "horizontal") guidePointer(event, "horizontal"); }} onPointerUp={(event) => guidePointer(event, "horizontal", true)}>
      {horizontalTicks.map((value) => <i key={value} style={{ left: rulerLocalPosition(value * viewport.zoom + documentOriginX) }}><span>{formatTick(value)}</span></i>)}
    </div>
    <div className="ruler-vertical" onContextMenu={openUnitMenu} onPointerDown={(event) => guidePointer(event, "vertical")} onPointerMove={(event) => { if (guideDraft?.orientation === "vertical") guidePointer(event, "vertical"); }} onPointerUp={(event) => guidePointer(event, "vertical", true)}>
      {verticalTicks.map((value) => <i key={value} style={{ top: rulerLocalPosition(value * viewport.zoom + documentOriginY) }}><span>{formatTick(value)}</span></i>)}
    </div>
    {unitMenu && <div className="ruler-unit-menu" style={{ left: unitMenu.x, top: unitMenu.y }} role="menu">{(["px", "in", "mm", "cm"] as const).map((unit) => <button key={unit} className={rulerUnit === unit ? "active" : ""} onClick={() => { updatePreferences({ rulerUnit: unit as RulerUnit }); setUnitMenu(null); }}>{unit === "px" ? "Pixels (Пиксели)" : unit === "in" ? "Inches (Дюймы)" : unit === "mm" ? "Millimeters (Миллиметры)" : "Centimeters (Сантиметры)"}</button>)}</div>}
  </div>;

  return { guideOverlay, rulers };
}
