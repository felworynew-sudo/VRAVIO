import { useEffect, useRef } from "react";
import { appendLayer, cloneRasterState, compositeRasterDocument, createRasterLayer, cropRasterDocument, layerAccepts, setLayerPixels, type Point, type RasterDocumentState, type RasterRect } from "@vravio/env-raster";
import { kernel } from "../../../../kernel";
import { beginBusy } from "../../../../busy";
import { errorModal } from "../../../../modals/runtime";
import { defaultInpaintModelId, inpaintModelById } from "../../../../ml/inpaint/registry";
import { runInpaint } from "../../../../ml/inpaint/run";
import type { RasterToolDefinition, ToolContext } from "../types";

/**
 * Crop — a pending, adjustable session instead of the old single-drag-and-
 * commit gesture (docs/master-plan.md §2.1: rated 3.5/10, "the bluntest tool
 * relative to the others"). Modeled directly on Patchy's own crop session
 * (`src/ui/canvas_widget_crop.cpp`, read in full before writing this): a
 * drag-out lays out a rect, 8 handles and a move-inside-frame drag adjust it,
 * a shield darkens everything outside it, rule-of-thirds guides appear once
 * the box is big enough to benefit, and nothing is committed to the document
 * until Enter (or a click outside the frame — the same "clicking away
 * accepts" convention move.tsx already uses).
 *
 * Deliberately NOT ported from Patchy in this pass: rotate/straighten (drag
 * outside the box to tilt it) and growing the rect past the canvas edge
 * ("Allow Canvas Extension" / content-aware expand) — both real gaps, both
 * left as follow-ups in master-plan.md §2.1 rather than silently dropped.
 */

type HandleId = "tl" | "t" | "tr" | "l" | "r" | "bl" | "b" | "br";
const HANDLES: readonly { id: HandleId; hx: -1 | 0 | 1; hy: -1 | 0 | 1 }[] = [
  { id: "tl", hx: -1, hy: -1 }, { id: "t", hx: 0, hy: -1 }, { id: "tr", hx: 1, hy: -1 },
  { id: "l", hx: -1, hy: 0 }, { id: "r", hx: 1, hy: 0 },
  { id: "bl", hx: -1, hy: 1 }, { id: "b", hx: 0, hy: 1 }, { id: "br", hx: 1, hy: 1 },
];

interface PendingCrop { readonly rect: RasterRect }

type CropDrag =
  | { kind: "out"; pointerId: number; anchor: Point }
  | { kind: "move"; pointerId: number; startRect: RasterRect; startPoint: Point }
  | { kind: "handle"; pointerId: number; handle: HandleId; startRect: RasterRect; startPoint: Point };

interface CropState {
  readonly pending: PendingCrop | null;
  readonly drag: CropDrag | null;
}

const empty: CropState = { pending: null, drag: null };

/** `undefined` means Unconstrained — every other value is a fixed W/H ratio. */
function ratioFor(value: string, documentWidth: number, documentHeight: number): number | undefined {
  switch (value) {
    case "original": return documentWidth / documentHeight;
    case "1:1": return 1;
    case "4:5": return 4 / 5;
    case "5:7": return 5 / 7;
    case "2:3": return 2 / 3;
    case "16:9": return 16 / 9;
    default: return undefined;
  }
}

/** Keeps the rect entirely within the canvas, unless "AI Border Fill" is on — dragging a handle
 * past the edge then means "grow the canvas here", not "stop at the edge" (docs/master-plan.md
 * §52.8's own "Allow Canvas Extension" gap, closed by the same option that fills what it exposes). */
function clampToCanvas(rect: RasterRect, width: number, height: number, allowExtension: boolean): RasterRect {
  if (allowExtension) return rect;
  const w = Math.min(rect.width, width), h = Math.min(rect.height, height);
  const x = Math.max(0, Math.min(rect.x, width - w));
  const y = Math.max(0, Math.min(rect.y, height - h));
  return { x, y, width: w, height: h };
}

function rectFromDragOut(anchor: Point, current: Point, ratio: number | undefined): RasterRect {
  let dx = current.x - anchor.x, dy = current.y - anchor.y;
  if (ratio) {
    const width = Math.abs(dx), height = Math.abs(dy);
    if (width / Math.max(height, 1e-6) > ratio) dx = Math.sign(dx || 1) * Math.max(1, height * ratio);
    else dy = Math.sign(dy || 1) * Math.max(1, width / ratio);
  }
  return { x: Math.min(anchor.x, anchor.x + dx), y: Math.min(anchor.y, anchor.y + dy), width: Math.max(1, Math.abs(dx)), height: Math.max(1, Math.abs(dy)) };
}

/** The same corner/edge math as Patchy's `update_crop_adjust_drag` — a locked ratio always
 * constrains; an unlocked edge drag just moves that one side, an unlocked corner drag moves both. */
function applyHandleDrag(start: RasterRect, handle: HandleId, point: Point, ratio: number | undefined): RasterRect {
  const info = HANDLES.find((entry) => entry.id === handle)!;
  const movesLeft = info.hx === -1, movesRight = info.hx === 1, movesTop = info.hy === -1, movesBottom = info.hy === 1;
  const corner = info.hx !== 0 && info.hy !== 0;

  if (ratio && corner) {
    const anchorX = movesLeft ? start.x + start.width : start.x, anchorY = movesTop ? start.y + start.height : start.y;
    let width = Math.max(1, Math.abs(point.x - anchorX)), height = Math.max(1, Math.abs(point.y - anchorY));
    if (width / height > ratio) width = Math.max(1, height * ratio); else height = Math.max(1, width / ratio);
    return { x: point.x < anchorX ? anchorX - width : anchorX, y: point.y < anchorY ? anchorY - height : anchorY, width, height };
  }
  if (ratio) {
    if (movesLeft || movesRight) {
      const anchorX = movesLeft ? start.x + start.width : start.x;
      const width = Math.max(1, Math.abs(point.x - anchorX)), height = Math.max(1, width / ratio);
      return { x: point.x < anchorX ? anchorX - width : anchorX, y: start.y + start.height / 2 - height / 2, width, height };
    }
    const anchorY = movesTop ? start.y + start.height : start.y;
    const height = Math.max(1, Math.abs(point.y - anchorY)), width = Math.max(1, height * ratio);
    return { x: start.x + start.width / 2 - width / 2, y: point.y < anchorY ? anchorY - height : anchorY, width, height };
  }
  let left = start.x, top = start.y, right = start.x + start.width, bottom = start.y + start.height;
  if (movesLeft) left = point.x;
  if (movesRight) right = point.x;
  if (movesTop) top = point.y;
  if (movesBottom) bottom = point.y;
  return { x: Math.min(left, right), y: Math.min(top, bottom), width: Math.max(1, Math.abs(right - left)), height: Math.max(1, Math.abs(bottom - top)) };
}

/** The one rect-for-this-frame computation, shared between the RAF-coalesced live preview
 * (onPointerMove) and the final, synchronous frame (onGestureEnd) — the same split
 * move.tsx's own `applyDragFrame` uses, for the same reason (its own comment on
 * `scheduleWork`): a fast pointer-up can land before the last scheduled RAF runs, so
 * gesture end has to compute the true final rect itself rather than trust whatever
 * pending already happens to hold. */
function rectForDrag(drag: CropDrag, point: Point, width: number, height: number, ratio: number | undefined, allowExtension: boolean): RasterRect {
  if (drag.kind === "out") return clampToCanvas(rectFromDragOut(drag.anchor, point, ratio), width, height, allowExtension);
  if (drag.kind === "move") {
    const dx = point.x - drag.startPoint.x, dy = point.y - drag.startPoint.y;
    const x = allowExtension ? drag.startRect.x + dx : Math.max(0, Math.min(drag.startRect.x + dx, width - drag.startRect.width));
    const y = allowExtension ? drag.startRect.y + dy : Math.max(0, Math.min(drag.startRect.y + dy, height - drag.startRect.height));
    return { x, y, width: drag.startRect.width, height: drag.startRect.height };
  }
  return clampToCanvas(applyHandleDrag(drag.startRect, drag.handle, point, ratio), width, height, allowExtension);
}

/**
 * Fills the border a canvas-extending crop just exposed, on its own new layer.
 *
 * Runs after the crop itself has already committed — inpainting is a model
 * call that takes real time, and `inpaint.tsx`'s own `fill()` already
 * established the pattern for this project: the fast, synchronous part
 * (here, the crop) lands immediately, the slow part follows as its own
 * separate history step once the model answers, with a busy indicator
 * standing in for the wait.
 *
 * The owner's own explicit requirement: the fill lands as a *new layer on
 * top*, not written over what is already there. `runInpaint` returns a full
 * composited picture (existing content plus the fill blended in), so only
 * the pixels the mask actually covers are kept here — the rest of the new
 * layer stays transparent, and the original layers underneath are untouched.
 */
async function fillExtendedBorder(documentId: string, oldWidth: number, oldHeight: number, cropRect: RasterRect, modelId: string): Promise<void> {
  const model = inpaintModelById(modelId) ?? inpaintModelById(defaultInpaintModelId);
  if (!model) return;
  const done = beginBusy("AI Border Fill (ИИ заливка границ)");
  try {
    const live = kernel.documents.get<RasterDocumentState>(documentId);
    if (!live) return;
    const state = live.state;
    const composite = compositeRasterDocument(state);
    // Where the old canvas now sits in the new one — everything else is the
    // border this crop exposed, the same sign flip `cropRasterDocument`'s
    // own `left`/`top` uses for `slideLayerBounds`.
    const oldLeft = -Math.floor(cropRect.x), oldTop = -Math.floor(cropRect.y);
    const mask = new Uint8ClampedArray(state.width * state.height);
    for (let y = 0; y < state.height; y += 1) {
      const inOldRowRange = y >= oldTop && y < oldTop + oldHeight;
      for (let x = 0; x < state.width; x += 1) {
        if (inOldRowRange && x >= oldLeft && x < oldLeft + oldWidth) continue;
        mask[y * state.width + x] = 255;
      }
    }
    // The whole canvas as the region, not `runInpaint`'s own auto-detected crop around the
    // marked pixels: a border wraps most of the image's own perimeter, so the auto-detected
    // box is close to the whole canvas anyway, except clamped down to a small square around it
    // — which left most of a wide/tall border outside the model's view entirely (found live,
    // §52.8 — see `runInpaint`'s own comment on its `region` option). The trade this makes for a
    // large document is real: the whole photo gets downscaled to the model's fixed square rather
    // than only the border at full detail, so a big canvas fills at lower fidelity than a small
    // one. Correct and complete beats sharp and half-missing.
    const outcome = await runInpaint(model, composite, state.width, state.height, mask, { region: { x: 0, y: 0, width: state.width, height: state.height } });
    if (outcome.error) { errorModal({ title: "AI border fill failed (Не удалось заполнить границы)", message: `${model.id}: ${outcome.error}` }); return; }
    if (!outcome.pixels) return;

    const isolated = new Uint8ClampedArray(outcome.pixels.length);
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      if (!mask[pixel]) continue;
      const at = pixel * 4;
      isolated[at] = outcome.pixels[at]!; isolated[at + 1] = outcome.pixels[at + 1]!; isolated[at + 2] = outcome.pixels[at + 2]!; isolated[at + 3] = outcome.pixels[at + 3]!;
    }

    const before = cloneRasterState(state);
    const after = cloneRasterState(state);
    const layer = createRasterLayer(after.width, after.height, "AI Border Fill (ИИ заливка границ)");
    setLayerPixels(layer, isolated, after.width, after.height);
    appendLayer(after, layer);
    after.activeLayerId = layer.id;

    const history = kernel.historyByDocument.get(documentId);
    if (!history) return;
    const clone = (value: RasterDocumentState) => cloneRasterState(value);
    await history.execute({
      label: "AI Border Fill (ИИ заливка границ)",
      redo: () => { kernel.documents.update<RasterDocumentState>(documentId, (current) => { Object.assign(current, clone(after)); }); },
      undo: () => { kernel.documents.update<RasterDocumentState>(documentId, (current) => { Object.assign(current, clone(before)); }); },
    });
  } catch (error) {
    errorModal({ title: "AI border fill failed (Не удалось заполнить границы)", message: error instanceof Error ? error.message : String(error) });
  } finally {
    done();
  }
}

function commitCrop(context: ToolContext<CropState>, pending: PendingCrop): void {
  const before = cloneRasterState(context.document);
  const deleteCroppedPixels = Boolean(context.options.deleteCroppedPixels);
  const oldWidth = before.width, oldHeight = before.height;
  const extendsBeyondCanvas = pending.rect.x < 0 || pending.rect.y < 0 || pending.rect.x + pending.rect.width > oldWidth || pending.rect.y + pending.rect.height > oldHeight;
  const aiBorderFill = Boolean(context.options.aiBorderFill) && extendsBeyondCanvas;
  const after = cropRasterDocument(before, pending.rect, deleteCroppedPixels, aiBorderFill);
  const documentId = context.documentId, modelId = String(context.options.aiFillModel ?? defaultInpaintModelId);
  // Awaited before the fill reads the document back: `commitDocument` records the crop through
  // `history.execute`, which is itself async (`ReversibleOperation.redo` may be awaited), so the
  // live document is still the *pre-crop* one for a tick after this call returns. Reading it too
  // early was found live: the fill silently did nothing, because it built its border mask against
  // the old, uncropped canvas — a mask covering "the old canvas minus itself" left `regionForMask`
  // nothing to mark, and a nothing-was-marked result is not an error (`ml/inpaint/run.ts`'s own
  // comment on that), so it returned quietly instead of throwing.
  const committed = context.commitDocument(before, after, "Crop (Кадрирование)");
  context.resetViewportToFit();
  if (aiBorderFill) void committed.then(() => fillExtendedBorder(documentId, oldWidth, oldHeight, pending.rect, modelId));
}

const crop: RasterToolDefinition<CropState> = {
  id: "raster.crop",
  createState: () => empty,

  onPointerDown(context, pointer) {
    const pending = context.state.pending;
    const zoom = context.viewport.zoom;
    const tolerance = 11 / zoom;

    if (pending) {
      const handle = HANDLES.find((entry) => {
        const hx = pending.rect.x + (entry.hx + 1) * pending.rect.width / 2, hy = pending.rect.y + (entry.hy + 1) * pending.rect.height / 2;
        return Math.hypot(pointer.point.x - hx, pointer.point.y - hy) <= tolerance;
      });
      if (handle) {
        context.capturePointer(pointer.pointerId);
        context.setState({ pending, drag: { kind: "handle", pointerId: pointer.pointerId, handle: handle.id, startRect: pending.rect, startPoint: pointer.point } });
        return;
      }
      const inside = pointer.point.x >= pending.rect.x && pointer.point.x <= pending.rect.x + pending.rect.width && pointer.point.y >= pending.rect.y && pointer.point.y <= pending.rect.y + pending.rect.height;
      if (inside) {
        context.capturePointer(pointer.pointerId);
        context.setState({ pending, drag: { kind: "move", pointerId: pointer.pointerId, startRect: pending.rect, startPoint: pointer.point } });
        return;
      }
      // Clicking away from the frame accepts the crop, the way it does for move.tsx's Free Transform.
      commitCrop(context, pending);
      context.setState(empty);
      return;
    }

    if (context.activeLayer && !layerAccepts(context.activeLayer, "move")) return;
    context.capturePointer(pointer.pointerId);
    context.setState({ pending: null, drag: { kind: "out", pointerId: pointer.pointerId, anchor: pointer.point } });
  },

  onPointerMove(context, pointer) {
    const drag = context.state.drag;
    if (!drag || drag.pointerId !== pointer.pointerId) return;
    const { width, height } = context.document;
    const ratio = ratioFor(String(context.options.ratio ?? "unconstrained"), width, height);
    const allowExtension = Boolean(context.options.aiBorderFill);
    // Native pointermove can fire well above the display's own frame rate — computing and
    // committing a new React state on every single one of them (a full RasterWorkspace +
    // Overlay re-render, plus this component's own keydown-listener effect re-subscribing,
    // see the Overlay's own comment) is the kind of per-event work CLAUDE.md's brush-hot-path
    // lesson already covers, even though the rect math itself is cheap: `scheduleWork` runs
    // only the most recently scheduled closure once per animation frame, dropping the rest,
    // matching move.tsx's identical use of it for its own (heavier) per-frame resample.
    const point = pointer.point;
    context.scheduleWork(() => {
      context.setState({ pending: { rect: rectForDrag(drag, point, width, height, ratio, allowExtension) }, drag });
    });
  },

  onGestureEnd(context, pointer) {
    const drag = context.state.drag;
    if (!drag || drag.pointerId !== pointer.pointerId) { context.setState({ pending: context.state.pending, drag: null }); return; }
    const { width, height } = context.document;
    const ratio = ratioFor(String(context.options.ratio ?? "unconstrained"), width, height);
    const allowExtension = Boolean(context.options.aiBorderFill);
    // Synchronous, not the scheduled frame above: a fast pointer-up can land before the last
    // scheduleWork callback runs, and the release position is the one the user actually meant.
    const pending: PendingCrop = { rect: rectForDrag(drag, pointer.point, width, height, ratio, allowExtension) };
    if (drag.kind === "out" && (pending.rect.width < 2 || pending.rect.height < 2)) { context.setState(empty); return; }
    context.setState({ pending, drag: null });
  },

  onDeactivate(context) {
    if (context.state.pending) commitCrop(context, context.state.pending);
    if (context.state.pending || context.state.drag) context.setState(empty);
  },

  Overlay({ state, document, context }) {
    const pending = state.pending;
    // `pending`/`context` are fresh objects on every frame of a drag (the rect itself is
    // changing, and `context` is rebuilt by the host on every render regardless) — reading
    // them through a ref rather than closing over them directly means the listener below only
    // has to be torn down and rebuilt when a crop session actually starts or ends, not on every
    // one of the ~60 rect updates a one-second drag produces.
    const latest = useRef({ pending, context });
    latest.current = { pending, context };
    // Same pair every settled-but-uncommitted edit in this project offers (move.tsx's Free
    // Transform, the raster mask/selection tools): Enter commits, Escape discards.
    useEffect(() => {
      if (!pending) return;
      const onKeyDown = (event: KeyboardEvent) => {
        const current = latest.current;
        if (!current.pending) return;
        if (event.key === "Enter") { event.preventDefault(); commitCrop(current.context, current.pending); current.context.setState(empty); }
        else if (event.key === "Escape") { event.preventDefault(); current.context.setState(empty); }
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Boolean(pending)]);

    if (!pending) return null;
    const { rect } = pending;
    const zoom = context.viewport.zoom;
    const strokeWidth = 1 / zoom;
    // Interface never scales with document zoom (CLAUDE.md §1) — handle size and every stroke
    // width here are computed against `zoom`, not left to `vector-effect:non-scaling-stroke`
    // (documented in the same section as unreliable under a scaled ancestor transform).
    const handleSize = 8 / zoom;
    const thirds = rect.width * zoom >= 24 && rect.height * zoom >= 24;

    return <svg className="crop-controls" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="crop-shield" fillRule="evenodd" d={`M0,0H${document.width}V${document.height}H0Z M${rect.x},${rect.y}H${rect.x + rect.width}V${rect.y + rect.height}H${rect.x}Z`} />
      {thirds && [1, 2].flatMap((i) => {
        const x = rect.x + rect.width * i / 3, y = rect.y + rect.height * i / 3;
        return [
          <line key={`v${i}`} className="crop-third" x1={x} y1={rect.y} x2={x} y2={rect.y + rect.height} strokeWidth={strokeWidth} />,
          <line key={`h${i}`} className="crop-third" x1={rect.x} y1={y} x2={rect.x + rect.width} y2={y} strokeWidth={strokeWidth} />,
        ];
      })}
      {/* The dash lengths are a screen measurement too, so they divide by the zoom
          like the width beside them; left in CSS they stretched with the document. */}
      <rect className="crop-outline" x={rect.x} y={rect.y} width={rect.width} height={rect.height} strokeWidth={strokeWidth} strokeDasharray={`${4 * strokeWidth} ${3 * strokeWidth}`} />
      {HANDLES.map((entry) => {
        const hx = rect.x + (entry.hx + 1) * rect.width / 2, hy = rect.y + (entry.hy + 1) * rect.height / 2;
        return <rect className="crop-handle" key={entry.id} x={hx - handleSize / 2} y={hy - handleSize / 2} width={handleSize} height={handleSize} strokeWidth={strokeWidth} />;
      })}
    </svg>;
  },
};

export default crop;
