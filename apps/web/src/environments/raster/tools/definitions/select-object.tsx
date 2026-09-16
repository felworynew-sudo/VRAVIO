import { useEffect, useRef } from "react";
import { selectionBounds, type PixelSelection, type Point } from "@vravio/env-raster";
import { beginBusy } from "../../../../busy";
import { errorModal } from "../../../../modals/runtime";
import { decodeMask, encodeImage, loadInteractiveSelectSessions, type EncodedImage, type InteractiveSelectSessions } from "../../../../ml/interactive-select/run";
import { defaultInteractiveSelectModelId, interactiveSelectModelById } from "../../../../ml/interactive-select/registry";
import type { SamPoint } from "../../../../ml/interactive-select/types";
import type { RasterToolDefinition, ToolContext } from "../types";

/**
 * Object Selection (docs/master-plan.md §52.5) — MobileSAM's click/box prompt, run on the active
 * layer's own pixels (the same scoping choice `RasterPixelLayerProperties.tsx`'s Quick Actions
 * already made for U²-Net-P, and for the same reason: the common case is one photo on one layer,
 * and finding the subject *within this layer* rather than the full composite is a real, stated
 * choice for a first pass, not an oversight).
 *
 * A click adds a foreground point (Alt-click: background/exclude); a drag draws a box, which
 * replaces whatever points came before it rather than combining with them — matching how the
 * reference SAM demos use a box (as the whole prompt, not one ingredient among several). Every
 * prompt after the first re-runs only the lightweight decoder against the same cached image
 * embedding — encoding the image is the expensive part, and `ml/interactive-select/run.ts`'s own
 * comment on `sessionCache` covers why the encoder/decoder *sessions* are cached at module scope
 * rather than reloaded here too.
 *
 * Deliberately out of scope for this pass, the same way `magic-wand.ts`'s own combine modes are
 * not: adding/subtracting this tool's own result against the document's *existing* selection.
 * Alt is already spent on "background point" within a SAM session, and Photoshop's own Object
 * Selection Tool resolves the same clash with dedicated New/Add/Subtract/Intersect buttons in its
 * options bar rather than a modifier — a real follow-up, not silently dropped.
 */

interface SamSession {
  readonly layerId: string;
  /** `null` while the encoder is still running; the promise so a second click before the first
   * one finishes awaits the same work instead of starting a redundant encode. */
  readonly encoding: Promise<EncodedImage | { error: string }>;
  points: readonly SamPoint[];
  previewMask: Uint8ClampedArray | null;
}

interface SelectObjectState {
  session: SamSession | null;
  drag: { pointerId: number; start: Point; current: Point } | null;
}

const empty: SelectObjectState = { session: null, drag: null };

/** How far a release has to land from where the gesture started, in document pixels at the
 * current zoom, before this reads as a box rather than a click — Photoshop's own click/drag
 * threshold for its marquee tools, reused here for the same reason: a hand is not perfectly
 * still, and a hair's-width release should not turn an intended point into a one-pixel box. */
const DRAG_THRESHOLD_SCREEN = 4;

async function currentSessions(context: ToolContext<SelectObjectState>): Promise<InteractiveSelectSessions | { error: string }> {
  const model = interactiveSelectModelById(String(context.options.model ?? defaultInteractiveSelectModelId)) ?? interactiveSelectModelById(defaultInteractiveSelectModelId);
  if (!model) return { error: "No interactive selection model is registered." };
  return loadInteractiveSelectSessions(model, {});
}

/**
 * Which `updatePrompt` call is the most recent one — a plain module-level counter, not
 * `context.state`. `ToolContext.state` is a snapshot taken when the context was built for this
 * one gesture (CLAUDE.md's own documented trap, first found on `raster.move`'s pending-transform
 * ref), not a live view of `toolStatesRef`; re-reading `context.state.session` inside an async
 * continuation to check "did a newer click arrive" always saw the *pre-click* state and bailed
 * out immediately, every time — found live here as "the mask decodes but nothing ever appears".
 */
let latestRequest = 0;

/** Starts (or continues) a SAM session for the active layer and re-decodes with the given
 * points — the one place both a fresh click and a box drag end up. */
function updatePrompt(context: ToolContext<SelectObjectState>, points: readonly SamPoint[], replace: boolean): void {
  const layer = context.activeLayer;
  if (!layer) return;
  const state = context.state;
  const existing = state.session && state.session.layerId === layer.id ? state.session : null;
  const model = interactiveSelectModelById(String(context.options.model ?? defaultInteractiveSelectModelId)) ?? interactiveSelectModelById(defaultInteractiveSelectModelId);
  if (!model) return;

  const encoding = existing?.encoding ?? (async (): Promise<EncodedImage | { error: string }> => {
    const sessions = await currentSessions(context);
    if ("error" in sessions) return sessions;
    const { width, height } = context.document;
    return encodeImage(sessions, model, context.layerPixels(), width, height);
  })();

  const nextPoints = replace || !existing ? points : [...existing.points, ...points];
  const session: SamSession = { layerId: layer.id, encoding, points: nextPoints, previewMask: existing?.previewMask ?? null };
  // `drag: null`, not `...state` — `state` was already stale the moment `onGestureEnd`'s own
  // prior `setState` call cleared `drag`: `context.state` never updates after the context was
  // built (see `latestRequest`'s own comment below), so spreading it here would resurrect the
  // drag `onGestureEnd` just cleared. The gesture that led here is always over by this point.
  context.setState({ drag: null, session });

  const request = ++latestRequest;
  const done = beginBusy("Selecting object (Выделение объекта)");
  void (async () => {
    try {
      const sessions = await currentSessions(context);
      if ("error" in sessions) { errorModal({ title: "Object selection failed (Не удалось выделить объект)", message: sessions.error }); return; }
      const encoded = await encoding;
      if ("error" in encoded) { if (encoded.error) errorModal({ title: "Object selection failed (Не удалось выделить объект)", message: encoded.error }); return; }
      if (request !== latestRequest) return; // a newer click/box already started its own decode
      const outcome = await decodeMask(sessions, model, encoded, nextPoints);
      if ("error" in outcome) { if (outcome.error) errorModal({ title: "Object selection failed (Не удалось выделить объект)", message: outcome.error }); return; }
      if (request !== latestRequest) return;
      // Not `{...context.state, ...}` — `context.state` is the same pre-gesture snapshot the
      // comment above warns about, and spreading it here would silently resurrect whatever
      // `drag` held *before* this gesture, undoing the `drag: null` `onGestureEnd` already
      // committed to the live state. By the time this runs the gesture is over regardless.
      context.setState({ drag: null, session: { layerId: layer.id, encoding, points: nextPoints, previewMask: outcome } });
      context.previewSelectionBrushMask(outcome, 0, 0, context.document.width, context.document.height);
    } finally {
      done();
    }
  })();
}

function commit(context: ToolContext<SelectObjectState>): void {
  const session = context.state.session;
  if (!session?.previewMask) return;
  const { width, height } = context.document;
  const bounds = selectionBounds(session.previewMask, width, height);
  const after: PixelSelection | null = bounds.width && bounds.height ? { mask: session.previewMask, bounds } : null;
  void context.commitSelection(context.selection, after, "Object Selection (Выделение объекта)");
}

const selectObject: RasterToolDefinition<SelectObjectState> = {
  id: "raster.selectObject",
  createState: () => empty,

  onPointerDown(context, pointer) {
    context.capturePointer(pointer.pointerId);
    context.setState({ ...context.state, drag: { pointerId: pointer.pointerId, start: pointer.point, current: pointer.point } });
  },

  onPointerMove(context, pointer) {
    const drag = context.state.drag;
    if (!drag || drag.pointerId !== pointer.pointerId) return;
    context.setState({ ...context.state, drag: { ...drag, current: pointer.point } });
  },

  onGestureEnd(context, pointer) {
    const drag = context.state.drag;
    if (!drag || drag.pointerId !== pointer.pointerId) return;
    context.setState({ ...context.state, drag: null });
    const zoom = context.viewport.zoom;
    const distance = Math.hypot(pointer.point.x - drag.start.x, pointer.point.y - drag.start.y) * zoom;
    if (distance > DRAG_THRESHOLD_SCREEN) {
      const left = Math.min(drag.start.x, pointer.point.x), top = Math.min(drag.start.y, pointer.point.y);
      const right = Math.max(drag.start.x, pointer.point.x), bottom = Math.max(drag.start.y, pointer.point.y);
      updatePrompt(context, [{ x: left, y: top, label: 2 }, { x: right, y: bottom, label: 3 }], true);
    } else {
      updatePrompt(context, [{ x: pointer.point.x, y: pointer.point.y, label: pointer.altKey ? 0 : 1 }], false);
    }
  },

  onDeactivate(context) {
    if (context.state.session || context.state.drag) context.setState(empty);
    context.previewWithLayerHidden(null);
  },

  Overlay({ state, context }) {
    const drag = state.drag;
    const zoom = context.viewport.zoom;
    const strokeWidth = 1 / zoom;
    const points = state.session?.points ?? [];
    return <svg className="select-object-controls" viewBox={`0 0 ${context.document.width} ${context.document.height}`} preserveAspectRatio="none" aria-hidden="true">
      {drag && Math.hypot(drag.current.x - drag.start.x, drag.current.y - drag.start.y) * zoom > DRAG_THRESHOLD_SCREEN && (
        <rect className="select-object-box" x={Math.min(drag.start.x, drag.current.x)} y={Math.min(drag.start.y, drag.current.y)}
          width={Math.abs(drag.current.x - drag.start.x)} height={Math.abs(drag.current.y - drag.start.y)} strokeWidth={strokeWidth}/>
      )}
      {points.filter((point) => point.label === 0 || point.label === 1).map((point, index) => (
        <circle key={index} className={point.label === 1 ? "select-object-point positive" : "select-object-point negative"}
          cx={point.x} cy={point.y} r={5 / zoom} strokeWidth={strokeWidth}/>
      ))}
    </svg>;
  },

  ScreenOverlay({ state, context }) {
    const session = state.session;
    // Read through a ref, not closed over directly — the same reason crop.tsx's own
    // ScreenOverlay does this: `context`/`state` are fresh objects on every render, and the
    // listener only needs tearing down and rebuilding when a session actually starts or ends.
    const latest = useRef({ session, context });
    latest.current = { session, context };
    useEffect(() => {
      if (!session) return;
      const onKeyDown = (event: KeyboardEvent) => {
        const current = latest.current;
        if (!current.session) return;
        const target = event.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
        if (event.key === "Enter") { event.preventDefault(); commit(current.context); current.context.setState(empty); current.context.previewWithLayerHidden(null); }
        else if (event.key === "Escape") { event.preventDefault(); current.context.setState(empty); current.context.previewWithLayerHidden(null); }
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Boolean(session)]);
    return null;
  },
};

export default selectObject;
