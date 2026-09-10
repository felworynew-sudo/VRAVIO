import { selectionBounds, selectionBrushStrokeSegment, selectionOutlinePath, type PixelSelection } from "@vravio/env-raster";
import type { RasterToolDefinition, ToolContext } from "../types";

/**
 * Photoshop's Selection Brush (shortcut L, shares the Lasso group — Shift+L
 * cycles the two). Paint to add to the selection, hold Alt to subtract —
 * momentary, not a mode captured at pointer-down, so the same stroke can
 * switch mid-drag exactly like Photoshop's own does (confirmed via
 * phlearn.com's walkthrough — Adobe's own help page 403'd). The live mark is
 * a semi-transparent magenta wash over the area currently painted,
 * deliberately not marching ants: partial/feathered coverage (a soft-edged
 * brush tip) has no honest binary outline until the stroke settles.
 *
 * Unlike the marquee/lasso tools, which build one shape and hand it to
 * `combineSelections` on release, this tool paints directly into a working
 * copy of the selection's own mask as the gesture runs — closer to how
 * Photoshop's brush-based selection actually behaves (you see the selection
 * itself grow and shrink live, not a pending shape that gets merged in at
 * the end) and it is what lets Alt-subtract erase pixels this same stroke
 * just added, not only pixels from an older, already-committed selection.
 */

interface Stroke {
  readonly pointerId: number;
  readonly before: PixelSelection | null;
  /** Full document-sized working copy of the selection mask, mutated dab by dab. */
  working: Uint8ClampedArray;
  pending: { x: number; y: number };
  /** Bounding rectangle touched so far this stroke — what the live overlay repaints, grown on demand like spot-heal's own accumulating mask. */
  dirtyX: number;
  dirtyY: number;
  dirtyRight: number;
  dirtyBottom: number;
}

export interface SelectionBrushState {
  readonly stroke: Stroke | null;
}

const empty: SelectionBrushState = { stroke: null };

function growDirty(stroke: Stroke, x: number, y: number, radius: number, width: number, height: number): void {
  stroke.dirtyX = Math.max(0, Math.min(stroke.dirtyX, Math.floor(x - radius)));
  stroke.dirtyY = Math.max(0, Math.min(stroke.dirtyY, Math.floor(y - radius)));
  stroke.dirtyRight = Math.min(width, Math.max(stroke.dirtyRight, Math.ceil(x + radius)));
  stroke.dirtyBottom = Math.min(height, Math.max(stroke.dirtyBottom, Math.ceil(y + radius)));
}

function previewStroke(context: ToolContext<SelectionBrushState>, stroke: Stroke): void {
  const { width, height } = context.document;
  const originX = stroke.dirtyX, originY = stroke.dirtyY;
  const w = stroke.dirtyRight - originX, h = stroke.dirtyBottom - originY;
  if (w <= 0 || h <= 0) return;
  const region = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    region[y * w + x] = stroke.working[(originY + y) * width + (originX + x)]!;
  }
  context.previewSelectionBrushMask(region, originX, originY, w, h);
}

const selectionBrush: RasterToolDefinition<SelectionBrushState> = {
  id: "raster.selectionBrush",
  createState: () => empty,

  onPointerDown(context, pointer) {
    context.capturePointer(pointer.pointerId);
    const { width, height } = context.document;
    const before = context.selection;
    const working = before ? before.mask.slice() : new Uint8ClampedArray(width * height);
    const options = context.options;
    const size = Number(options.size ?? 40);
    const hardness = Number(options.hardness ?? 100);
    const roundness = Number(options.roundness ?? 100);
    const mode = pointer.altKey ? "subtract" : "add";

    const stroke: Stroke = {
      pointerId: pointer.pointerId, before, working,
      pending: pointer.point,
      dirtyX: width, dirtyY: height, dirtyRight: 0, dirtyBottom: 0,
    };
    growDirty(stroke, pointer.point.x, pointer.point.y, size / 2 + 2, width, height);
    selectionBrushStrokeSegment(working, width, height, pointer.point.x, pointer.point.y, pointer.point.x, pointer.point.y, size, hardness, roundness, 0, mode);
    context.setState({ stroke });
    previewStroke(context, stroke);
  },

  onPointerMove(context, pointer) {
    const stroke = context.state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    const { width, height } = context.document;
    const options = context.options;
    const size = Number(options.size ?? 40);
    const hardness = Number(options.hardness ?? 100);
    const roundness = Number(options.roundness ?? 100);
    const spacing = Number(options.spacing ?? 12) / 100;
    const mode = pointer.altKey ? "subtract" : "add";

    growDirty(stroke, pointer.point.x, pointer.point.y, size / 2 + 2, width, height);
    growDirty(stroke, stroke.pending.x, stroke.pending.y, size / 2 + 2, width, height);
    selectionBrushStrokeSegment(stroke.working, width, height, stroke.pending.x, stroke.pending.y, pointer.point.x, pointer.point.y, size, hardness, roundness, 0, mode, spacing);
    stroke.pending = pointer.point;
    previewStroke(context, stroke);
  },

  onGestureEnd(context, pointer) {
    const stroke = context.state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    context.setState(empty);
    const { width, height } = context.document;
    const bounds = selectionBounds(stroke.working, width, height);
    const after: PixelSelection | null = bounds.width && bounds.height ? { mask: stroke.working, bounds } : null;
    // The tint was painted straight to the canvas, outside React and outside
    // the document's own pixels — a selection-only commit never bumps the
    // pixel revision that would otherwise repaint over it, the same gap
    // CLAUDE.md documents for any tool that draws outside `schedulePreview`'s
    // own contract. Recomposite the true picture explicitly before handing
    // the selection change to history.
    context.previewWithLayerHidden(null);
    void context.commitSelection(stroke.before, after, "Selection Brush (Кисть выделения)");
  },

  onDeactivate(context) {
    const state = context.state;
    if (!state.stroke) return;
    context.setState(empty);
    context.previewWithLayerHidden(null);
  },

  Overlay({ state, context, document }) {
    // While a stroke is running, the magenta tint (previewSelectionBrushMask)
    // is the live picture of the selection; the last-committed outline would
    // otherwise sit stale underneath it and read as two disagreeing answers.
    if (state.stroke) return null;
    const selection = context.selection;
    if (!selection) return null;
    const path = selectionOutlinePath(selection.mask, document.width, document.height);
    if (!path) return null;
    const zoom = context.viewport.zoom;
    return <svg className="selection-overlay" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={path} fill="none" stroke="#ec00ec" strokeOpacity={0.85} strokeWidth={1 / zoom} strokeDasharray={`${3 / zoom} ${3 / zoom}`}/>
    </svg>;
  },
};

export default selectionBrush;
