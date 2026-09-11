import { useState, type RefObject } from "react";
import { addGuide, removeGuide, setRulerOrigin, visibleGuides, type VectorDocumentState, type VectorGuide } from "@vravio/env-vector";
import { rulerLocalPosition, rulerStep } from "./raster-coordinates";
import { toDocumentPoint } from "./vector-coordinates";
import { changeVectorDocument } from "./vector-commands";
import type { DocumentViewport } from "./store";

/**
 * Stages 5/15 of docs/vector-plan.md: vector never had rulers or guides at
 * all — `raster-ruler-guides.tsx`'s own doc comment already explains why
 * this chrome has to live outside the zoom-scaled stage (screen-space,
 * `non-scaling-stroke` does not reliably cancel an *ancestor's* CSS
 * transform), and every reason there applies here unchanged. This is not a
 * copy of that hook: the coordinate math is different (a raster document's
 * own (0,0) sits at its canvas's own top-left; a vector document's visible
 * area is `computeCanvasBounds`'s dynamic box, centred by the stage's own
 * `translate(-50%,-50%)` around *its own* centre, not the document's), and
 * vector adds two things raster's guides don't need: `scope` (a guide can
 * belong to one artboard instead of the whole document) and a ruler
 * origin/mode toggle raster has no artboards to be relative to.
 *
 * The ruler origin/mode is a **labelling** setting only — moving it, or
 * switching to `"artboard"` mode, never moves a single pixel of anything.
 * A guide's `position` and every tick's screen position are always plain
 * document-space coordinates, exactly like raster's; only the *printed
 * number* next to a tick shifts by the effective origin. Getting this
 * backwards (baking the origin into where things are drawn) would make
 * every stored guide position mean something different depending on
 * whatever the ruler origin happened to be when it was read back.
 */
export function useVectorRulerGuides(params: {
  documentId: string;
  state: VectorDocumentState;
  viewport: DocumentViewport;
  workspaceRef: RefObject<HTMLDivElement | null>;
  workspaceSize: { width: number; height: number };
  canvasBounds: { x: number; y: number; width: number; height: number };
}) {
  const { documentId, state, viewport, workspaceRef, workspaceSize, canvasBounds } = params;
  const [guideDraft, setGuideDraft] = useState<VectorGuide | null>(null);

  const documentOriginX = workspaceSize.width / 2 + viewport.panX - (canvasBounds.x + canvasBounds.width / 2) * viewport.zoom;
  const documentOriginY = workspaceSize.height / 2 + viewport.panY - (canvasBounds.y + canvasBounds.height / 2) * viewport.zoom;

  const activeArtboard = state.artboards.find((artboard) => artboard.id === state.activeArtboardId) ?? null;
  const labelOrigin = state.rulerMode === "artboard" && activeArtboard
    ? { x: activeArtboard.x, y: activeArtboard.y }
    : (state.rulerOrigin ?? { x: 0, y: 0 });

  const guidePointer = (event: React.PointerEvent<HTMLDivElement>, orientation: VectorGuide["orientation"], finish = false) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const point = toDocumentPoint(event, workspace, viewport, canvasBounds);
    const position = orientation === "vertical" ? point.x : point.y;
    const next: VectorGuide = { orientation, position, scope: state.rulerMode === "artboard" ? state.activeArtboardId : null };
    if (!finish) { event.currentTarget.setPointerCapture(event.pointerId); setGuideDraft(next); return; }
    setGuideDraft(null);
    void changeVectorDocument(documentId, "Add Guide (Добавить направляющую)", (draft) => { addGuide(draft, orientation, position, next.scope); return true; });
  };

  // Drag from the ruler corner into the canvas to set a new zero point
  // (Illustrator's own gesture) — double-click resets to the document's
  // own (0, 0). Only meaningful in "global" mode; "artboard" mode's origin
  // always tracks the active artboard and isn't user-settable.
  const [originDrag, setOriginDrag] = useState(false);
  // The drag travels well outside this 18×18 corner element (out over the
  // ruler, then the canvas) — without capturing the pointer here, only
  // events while the cursor happens to still be over this element would
  // ever arrive, the same "real input, not synthetic" pointer-capture
  // subtlety CLAUDE.md §2 already documents for other drags in this repo.
  const cornerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (state.rulerMode !== "global") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setOriginDrag(true);
  };
  const cornerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!originDrag) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const point = toDocumentPoint(event, workspace, viewport, canvasBounds);
    void changeVectorDocument(documentId, "Move Ruler Origin (Переместить нулевую точку линейки)", (draft) => { setRulerOrigin(draft, point); return true; });
  };
  const cornerPointerUp = (event: React.PointerEvent<HTMLDivElement>) => { event.currentTarget.releasePointerCapture(event.pointerId); setOriginDrag(false); };
  const cornerDoubleClick = () => void changeVectorDocument(documentId, "Reset Ruler Origin (Сбросить нулевую точку линейки)", (draft) => { setRulerOrigin(draft, null); return true; });

  const step = rulerStep(viewport.zoom);
  const horizontalTicks: number[] = [], verticalTicks: number[] = [];
  for (let value = Math.floor(-documentOriginX / (step * viewport.zoom)) * step; value * viewport.zoom + documentOriginX < workspaceSize.width; value += step) horizontalTicks.push(value);
  for (let value = Math.floor(-documentOriginY / (step * viewport.zoom)) * step; value * viewport.zoom + documentOriginY < workspaceSize.height; value += step) verticalTicks.push(value);

  const guides = visibleGuides(state, state.activeArtboardId);
  const removeGuideAt = (guide: VectorGuide) => void changeVectorDocument(documentId, "Remove Guide (Удалить направляющую)", (draft) => { removeGuide(draft, guide.orientation, guide.position); return true; });

  // `.guide-overlay` is `pointer-events:none` at the container level (so a
  // guide never steals a click meant for the canvas beneath it) — shared
  // CSS with raster's own guides, which have no per-guide interaction to
  // need an exception from that. Double-click-to-remove needs one, but
  // only on the line's own thin stroke, not a hit-box the size of the
  // whole overlay: `pointerEvents: "stroke"` re-enables hit-testing for
  // this element alone, and only along the path actually drawn.
  const guideOverlay = <svg className="guide-overlay" width={workspaceSize.width} height={workspaceSize.height} aria-hidden="true">
    {[...guides, ...(guideDraft ? [guideDraft] : [])].map((guide, index) => guide.orientation === "vertical"
      ? <line key={`${guide.orientation}-${index}`} x1={guide.position * viewport.zoom + documentOriginX} y1={0} x2={guide.position * viewport.zoom + documentOriginX} y2={workspaceSize.height} style={{ pointerEvents: "stroke", cursor: "pointer" }} onDoubleClick={() => removeGuideAt(guide)}/>
      : <line key={`${guide.orientation}-${index}`} x1={0} y1={guide.position * viewport.zoom + documentOriginY} x2={workspaceSize.width} y2={guide.position * viewport.zoom + documentOriginY} style={{ pointerEvents: "stroke", cursor: "pointer" }} onDoubleClick={() => removeGuideAt(guide)}/>)}
  </svg>;

  const rulers = <div className="rulers" aria-hidden="true">
    <div className="ruler-corner" onPointerDown={cornerPointerDown} onPointerMove={cornerPointerMove} onPointerUp={cornerPointerUp} onDoubleClick={cornerDoubleClick} title="Drag to set the ruler's zero point, double-click to reset"/>
    <div className="ruler-horizontal" onPointerDown={(event) => guidePointer(event, "horizontal")} onPointerMove={(event) => { if (guideDraft?.orientation === "horizontal") guidePointer(event, "horizontal"); }} onPointerUp={(event) => guidePointer(event, "horizontal", true)}>
      {horizontalTicks.map((value) => <i key={value} style={{ left: rulerLocalPosition(value * viewport.zoom + documentOriginX) }}><span>{Math.round(value - labelOrigin.x)}</span></i>)}
    </div>
    <div className="ruler-vertical" onPointerDown={(event) => guidePointer(event, "vertical")} onPointerMove={(event) => { if (guideDraft?.orientation === "vertical") guidePointer(event, "vertical"); }} onPointerUp={(event) => guidePointer(event, "vertical", true)}>
      {verticalTicks.map((value) => <i key={value} style={{ top: rulerLocalPosition(value * viewport.zoom + documentOriginY) }}><span>{Math.round(value - labelOrigin.y)}</span></i>)}
    </div>
  </div>;

  return { guideOverlay, rulers };
}
