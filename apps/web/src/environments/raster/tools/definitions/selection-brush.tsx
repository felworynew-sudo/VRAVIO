import { useEffect } from "react";
import { fillEnclosedHoles, selectionBounds, selectionBrushStrokeSegment, unionRect, type PixelSelection, type RasterRect } from "@vravio/env-raster";
import type { RasterToolDefinition, ToolContext } from "../types";

/**
 * Photoshop's Selection Brush (shortcut L, shares the Lasso group — Shift+L
 * cycles the two). Paint to add to the selection, hold Alt to subtract —
 * momentary, not a mode captured at pointer-down, so the same stroke can
 * switch mid-drag exactly like Photoshop's own does (confirmed via
 * phlearn.com's walkthrough — Adobe's own help page 403'd).
 *
 * The whole selection reads as a translucent color wash the entire time this
 * tool is the active one — not marching ants, and not only while a stroke is
 * in progress. This is Quick Mask, not a pending shape: GIMP's own Quick Mask
 * (`app/core/gimpchannel-select.c`'s consumers, toggled by the same "Q"-style
 * affordance Photoshop uses) and Photoshop's own Quick Mask both represent a
 * selection this way — a rubylith-style overlay whose per-pixel alpha follows
 * the mask's own coverage, so a feathered edge reads as a gradient, not a
 * binary line — and both scope it to *while that mode/tool is active*, never
 * bleeding into the ordinary marching-ants view the rest of the time. Opacity
 * is the tool's own option, the same "wash strength" Quick Mask's options
 * dialog exposes, and purely a display knob: it dims the overlay, it does not
 * change what pixels end up selected.
 */

interface Stroke {
  readonly pointerId: number;
  readonly before: PixelSelection | null;
  /** Full document-sized working copy of the selection mask, mutated dab by dab. */
  working: Uint8ClampedArray;
  /** Where the gesture began — compared against where it ends, to tell a closed loop from an
   * open stroke (see onGestureEnd's own comment). */
  readonly start: { x: number; y: number };
  pending: { x: number; y: number };
  /**
   * Coalesces the live tint into one repaint per animation frame, exactly
   * the way `RasterWorkspace.tsx`'s own `schedulePreview` throttles brush
   * strokes. The first version of this tool painted straight to the canvas
   * on every `pointermove`, and kept widening the SAME rectangle for the
   * whole gesture rather than resetting it after each paint — so a drag
   * that swept most of a 2000×2000 canvas re-tinted a rectangle that only
   * ever grew, synchronously, once per pointer sample: exactly the
   * unthrottled-per-frame-cost bug CLAUDE.md already documents for the
   * adjustment dialog's live preview, reproduced here on a canvas-sized
   * scale instead of a slider. `frameDirty` is only what changed *since the
   * last paint* and is cleared the moment it is flushed. Coalescing itself
   * goes through `context.scheduleWork` — the same one-RAF "run the latest
   * fn" queue every other tool with a per-frame side effect already shares —
   * rather than calling `requestAnimationFrame` directly, which is also what
   * lets a plain unit test drive this tool without a browser's RAF at all.
   */
  frameDirty: RasterRect | null;
}

export interface SelectionBrushState {
  readonly stroke: Stroke | null;
}

const empty: SelectionBrushState = { stroke: null };

/** Extracts a region of the full-document mask, scaled by the tool's own display opacity, and blits it. */
function paintTint(context: ToolContext<SelectionBrushState>, mask: Uint8ClampedArray, region: RasterRect): void {
  const { width } = context.document;
  const opacity = Math.max(0, Math.min(100, Number(context.options.opacity ?? 50))) / 100;
  const originX = Math.max(0, Math.floor(region.x)), originY = Math.max(0, Math.floor(region.y));
  const w = Math.max(0, Math.ceil(region.x + region.width) - originX), h = Math.max(0, Math.ceil(region.y + region.height) - originY);
  if (w <= 0 || h <= 0) return;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    out[y * w + x] = Math.round(mask[(originY + y) * width + (originX + x)]! * opacity);
  }
  context.previewSelectionBrushMask(out, originX, originY, w, h);
}

function flushFramePaint(context: ToolContext<SelectionBrushState>, stroke: Stroke): void {
  const dirty = stroke.frameDirty;
  if (!dirty) return;
  stroke.frameDirty = null;
  paintTint(context, stroke.working, dirty);
}

function scheduleFramePaint(context: ToolContext<SelectionBrushState>, stroke: Stroke, touchedX: number, touchedY: number, radius: number): void {
  const { width, height } = context.document;
  const grown = unionRect(stroke.frameDirty, touchedX - radius, touchedY - radius, touchedX + radius, touchedY + radius, 0);
  stroke.frameDirty = {
    x: Math.max(0, grown.x), y: Math.max(0, grown.y),
    width: Math.min(width, grown.x + grown.width) - Math.max(0, grown.x),
    height: Math.min(height, grown.y + grown.height) - Math.max(0, grown.y),
  };
  context.scheduleWork(() => flushFramePaint(context, stroke));
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

    const stroke: Stroke = { pointerId: pointer.pointerId, before, working, start: pointer.point, pending: pointer.point, frameDirty: null };
    selectionBrushStrokeSegment(working, width, height, pointer.point.x, pointer.point.y, pointer.point.x, pointer.point.y, size, hardness, roundness, 0, mode);
    context.setState({ stroke });
    scheduleFramePaint(context, stroke, pointer.point.x, pointer.point.y, size / 2 + 2);
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

    selectionBrushStrokeSegment(stroke.working, width, height, stroke.pending.x, stroke.pending.y, pointer.point.x, pointer.point.y, size, hardness, roundness, 0, mode, spacing);
    const radius = size / 2 + 2;
    // Both ends of this segment, not just where the pointer landed — a fast
    // sweep can jump the tip's own radius or more between samples, and the
    // stroke drawn between them is exactly what `selectionBrushStrokeSegment`
    // just stamped.
    scheduleFramePaint(context, stroke, (stroke.pending.x + pointer.point.x) / 2, (stroke.pending.y + pointer.point.y) / 2, radius + Math.hypot(pointer.point.x - stroke.pending.x, pointer.point.y - stroke.pending.y) / 2);
    stroke.pending = pointer.point;
  },

  onGestureEnd(context, pointer) {
    const stroke = context.state.stroke;
    if (!stroke || stroke.pointerId !== pointer.pointerId) return;
    context.setState(empty);
    // The last dab's own frame may still be pending — show it now rather
    // than waiting up to one more animation frame after the pointer is
    // already up.
    flushFramePaint(context, stroke);
    const { width, height } = context.document;
    // Photoshop's own lasso behaviour, ported to a paint-based selection:
    // land the stroke's own release back near where it started, and the
    // loop reads as closed — its enclosed interior selects too, not just
    // the ring the brush actually painted over. Only for a stroke that
    // ended adding (Alt held at release means the last thing drawn was a
    // subtraction, and "fill the hole" is not the natural reading of
    // closing a loop while erasing).
    const size = Number(context.options.size ?? 40);
    const closesLoop = !pointer.altKey && Math.hypot(pointer.point.x - stroke.start.x, pointer.point.y - stroke.start.y) <= Math.max(size, 12);
    const working = closesLoop ? fillEnclosedHoles(stroke.working, width, height) : stroke.working;
    const bounds = selectionBounds(working, width, height);
    // Only when the fill actually changed something on screen: the ordinary
    // (non-closing) path already has the exactly-right tint on screen from
    // the live drag (see the note below), and repainting it again here would
    // just be wasted work, not a correctness fix.
    if (closesLoop) paintTint(context, working, bounds);
    const after: PixelSelection | null = bounds.width && bounds.height ? { mask: working, bounds } : null;
    // Deliberately no `previewWithLayerHidden(null)` here: the tint already
    // on screen is byte-for-byte what `after` is about to become, so
    // clearing it now and waiting for the async `commitSelection` below to
    // land and re-derive the same picture would only buy a visible flash —
    // the exact "glitch on completion" this was built to avoid. Nothing
    // else needs to change on screen; only the document's own selection and
    // history need to catch up, in the background.
    void context.commitSelection(stroke.before, after, "Selection Brush (Кисть выделения)");
  },

  onDeactivate(context) {
    const state = context.state;
    if (state.stroke) { flushFramePaint(context, state.stroke); context.setState(empty); }
    // The Quick-Mask-style wash is a representation of "this tool is active",
    // not of the selection itself — it has to come off the canvas the moment
    // another tool takes over, or that tool's own marching ants would be
    // fighting a stale tint underneath them.
    context.previewWithLayerHidden(null);
  },

  Overlay({ context }) {
    const selection = context.selection;
    const opacity = Number(context.options.opacity ?? 50);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      // Only the at-rest picture: a stroke in progress paints its own live
      // tint directly (see `scheduleFramePaint`), and `context.selection`
      // does not change until that stroke's async commit lands — so this
      // effect naturally sits out every frame of an active drag and only
      // ever repaints the settled state before or after one, never racing it.
      //
      // Cleared first, unconditionally: Alt-subtract (or an undo) can shrink
      // or move the selected area between one settled state and the next,
      // and the old tint outside the new bounds would otherwise never get
      // painted over — `previewWithLayerHidden(null)` is the same full
      // recomposite `onDeactivate` already uses for exactly this reason. The
      // tint itself is then scoped to `bounds`, not the whole canvas: cheap
      // for the ordinary case of a selection much smaller than the document,
      // and this whole pair only runs on a settled transition, not per frame.
      context.previewWithLayerHidden(null);
      if (!selection) return;
      paintTint(context, selection.mask, selection.bounds);
      // No cleanup here: `onDeactivate` above is this tool's one door for
      // "stop showing the wash", already wired to the workspace's own
      // tool-switch handler. A cleanup here as well would double the clear
      // (once from this effect re-running on every selection change, once
      // from onDeactivate) and, worse, run on a stale `context` closure from
      // a prior render — see CLAUDE.md on `context.state` snapshots.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selection, opacity]);
    return null;
  },
};

export default selectionBrush;
