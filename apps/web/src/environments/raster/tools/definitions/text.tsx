import { useRef, type CSSProperties } from "react";
import { cloneRasterState, createRasterLayer, setLayerPixels, type Point, type RasterDocumentState, type RasterLayer, type RasterTextData } from "@vravio/env-raster";
import { withBusy } from "../../../../busy";
import { renderTextLayerPixels } from "../../../../textRender";
import type { RasterToolDefinition, ToolContext, ToolPointer } from "../types";

/**
 * Places and edits text layers.
 *
 * The one tool in the catalogue whose editing surface is not pixels or a
 * vector overlay but a native `<textarea>` — typing, the cursor, selection,
 * IME composition, all of it is the browser's own, not reimplemented here.
 * `onPointerDown`/`onPointerMove`/`onGestureEnd` cover only the part the
 * contract was already built for: hit-testing an existing text layer, or
 * dragging out a frame for a new one. What happens after that — typing,
 * committing, cancelling — lives in `Overlay`, the first tool whose overlay
 * needs to call `commitDocument`/`setState` itself rather than only render
 * a shape from state (see `context` on `Overlay`'s props in types.ts).
 */

interface Gesture {
  readonly from: Point;
  readonly current: Point;
  readonly pointerId: number;
  readonly mode: string;
}

interface Draft {
  readonly point: Point;
  readonly value: string;
  readonly layerId?: string;
  readonly mode: "point" | "area" | "path" | "dynamic";
  readonly boxWidth?: number;
  readonly boxHeight?: number;
  readonly path?: { start: Point; control: Point; end: Point };
  readonly dynamicPreset?: "circle" | "arch" | "bow";
}

interface TextState {
  readonly gesture: Gesture | null;
  readonly draft: Draft | null;
}

const empty: TextState = { gesture: null, draft: null };

/** Finds the topmost text layer whose box contains `point`, the same
 * estimate-from-character-count-or-path-bounds hit test the old switch used
 * — there is no cached layout to hit-test against more precisely than this
 * until the layer is actually rasterised. */
function hitTestTextLayer(document: RasterDocumentState, point: Point): RasterLayer | undefined {
  return [...document.layers].reverse().find((item) => {
    if (item.kind !== "text" || !item.text) return false;
    const lines = item.text.value.split("\n");
    const width = item.text.boxWidth ?? Math.max(...lines.map((line) => line.length), 1) * item.text.fontSize * .65;
    const height = item.text.boxHeight ?? lines.length * item.text.fontSize * item.text.lineHeight;
    const left = item.text.path ? Math.min(item.text.path.start.x, item.text.path.end.x, item.text.path.control.x) : item.text.x;
    const top = item.text.path ? Math.min(item.text.path.start.y, item.text.path.end.y, item.text.path.control.y) - item.text.fontSize : item.text.y;
    return point.x >= left && point.x <= left + Math.max(width, item.text.path ? Math.abs(item.text.path.end.x - item.text.path.start.x) : 0)
      && point.y >= top && point.y <= top + Math.max(height, item.text.fontSize * 2);
  });
}

/** Rasterises the draft into a text layer and commits it — empty text
 * commits nothing (there is no sane empty text layer to leave behind), but
 * still restores the ordinary composite if editing had hidden a layer
 * underneath the textarea, which the old switch's equivalent early return
 * did not (see docs/migration-plan.md's writeup on this tool). */
function commitDraft(context: ToolContext<TextState>, draft: Draft): void {
  if (!draft.value) { context.previewWithLayerHidden(null); return; }
  const before = cloneRasterState(context.document);
  const existing = draft.layerId ? context.document.layers.find((item) => item.id === draft.layerId) : null;
  const layer: RasterLayer = existing
    ? { ...existing, pixels: existing.pixels.slice(), ...(existing.text ? { text: { ...existing.text } } : {}) }
    : createRasterLayer(context.document.width, context.document.height, draft.value.slice(0, 28));
  const options = context.options;
  const fontSize = existing?.text?.fontSize ?? Number(options.fontSize ?? 48);
  const fontFamily = existing?.text?.fontFamily ?? String(options.fontFamily ?? "Arial");
  const textX = existing?.text?.x ?? draft.point.x, textY = existing?.text?.y ?? draft.point.y;
  const lineHeight = existing?.text?.lineHeight ?? 1.2, letterSpacing = existing?.text?.letterSpacing ?? 0;
  const align = existing?.text?.align ?? "left", color = existing?.text?.color ?? context.foregroundColor;
  const bold = existing?.text?.bold ?? false, italic = existing?.text?.italic ?? false, underline = existing?.text?.underline ?? false;
  const boxWidth = existing?.text?.boxWidth ?? draft.boxWidth, boxHeight = existing?.text?.boxHeight ?? draft.boxHeight;
  const path = existing?.text?.path ?? draft.path, dynamicPreset = existing?.text?.dynamicPreset ?? draft.dynamicPreset;
  const textData: RasterTextData = {
    value: draft.value, x: textX, y: textY, fontFamily, fontSize, lineHeight, letterSpacing, align, color, bold, italic, underline,
    mode: existing?.text?.mode ?? draft.mode,
    ...(boxWidth !== undefined ? { boxWidth } : {}), ...(boxHeight !== undefined ? { boxHeight } : {}),
    ...(path ? { path } : {}), ...(dynamicPreset ? { dynamicPreset } : {}),
  };
  layer.text = textData;
  // Rasterising type paints the whole document surface and then scans it
  // for the glyph bounds; on a large canvas that is long enough to look
  // stuck without the busy indicator.
  setLayerPixels(layer, withBusy("Rasterising type (Растеризация текста)", () => renderTextLayerPixels(textData, context.document.width, context.document.height)), context.document.width, context.document.height);
  layer.kind = "text";
  layer.name = draft.value.slice(0, 28) || layer.name;
  const after = cloneRasterState(context.document);
  const index = after.layers.findIndex((item) => item.id === layer.id);
  if (index >= 0) after.layers[index] = layer; else after.layers.push(layer);
  after.activeLayerId = layer.id;
  void context.commitDocument(before, after, "Type Layer (Текстовый слой)");
}

const text: RasterToolDefinition<TextState> = {
  id: "raster.text",
  createState: () => empty,

  onPointerDown(context, pointer) {
    const hit = hitTestTextLayer(context.document, pointer.point);
    if (hit?.text) {
      context.setActiveLayer(hit.id);
      context.setState({
        gesture: null,
        draft: {
          point: { x: hit.text.x, y: hit.text.y }, value: hit.text.value, layerId: hit.id,
          mode: hit.text.mode ?? (hit.text.boxWidth ? "area" : "point"),
          ...(hit.text.boxWidth !== undefined ? { boxWidth: hit.text.boxWidth } : {}),
          ...(hit.text.boxHeight !== undefined ? { boxHeight: hit.text.boxHeight } : {}),
          ...(hit.text.path ? { path: hit.text.path } : {}),
          ...(hit.text.dynamicPreset ? { dynamicPreset: hit.text.dynamicPreset } : {}),
        },
      });
      // The live edit is an HTML overlay, not rendered pixels — the layer's
      // own rasterised text has to get out of the way underneath it, or the
      // two would show doubled.
      context.previewWithLayerHidden(hit.id);
      return;
    }
    const mode = String(context.options.textMode ?? "auto");
    context.capturePointer(pointer.pointerId);
    context.setState({ gesture: { from: pointer.point, current: pointer.point, pointerId: pointer.pointerId, mode }, draft: null });
  },

  onPointerMove(context, pointer) {
    const gesture = context.state.gesture;
    if (!gesture || gesture.pointerId !== pointer.pointerId) return;
    context.setState({ ...context.state, gesture: { ...gesture, current: pointer.point } });
  },

  onGestureEnd(context, pointer) {
    const gesture = context.state.gesture;
    if (!gesture || gesture.pointerId !== pointer.pointerId) return;
    const distance = Math.hypot(gesture.current.x - gesture.from.x, gesture.current.y - gesture.from.y);
    // A drag too small to be a drag still lays out *something*, 240px wide
    // from the click — a plain click is exactly this case (distance 0).
    const end = distance >= 4 ? gesture.current : { x: Math.min(context.document.width, gesture.from.x + 240), y: gesture.from.y };
    const width = Math.max(24, Math.abs(end.x - gesture.from.x)), height = Math.max(24, Math.abs(end.y - gesture.from.y));

    if (gesture.mode === "auto") {
      context.setState({
        gesture: null,
        draft: { point: gesture.from, value: "", mode: distance >= 4 ? "area" : "point", ...(distance >= 4 ? { boxWidth: width, boxHeight: height } : {}) },
      });
      return;
    }

    const dynamic = gesture.mode.startsWith("dynamic");
    const preset = gesture.mode === "dynamicCircle" ? "circle" : gesture.mode === "dynamicBow" ? "bow" : "arch";
    const middle = { x: (gesture.from.x + end.x) / 2, y: (gesture.from.y + end.y) / 2 };
    const control = preset === "bow" ? { x: middle.x, y: middle.y + Math.max(30, width * .22) }
      : preset === "circle" ? { x: middle.x, y: middle.y - Math.max(60, width * .65) }
      : { x: middle.x, y: middle.y - Math.max(30, width * .28) };
    context.setState({
      gesture: null,
      draft: {
        point: gesture.from, value: "", mode: dynamic ? "dynamic" : "path",
        boxWidth: width, boxHeight: Math.max(height, width * .5),
        path: { start: gesture.from, control, end },
        ...(dynamic ? { dynamicPreset: preset as "circle" | "arch" | "bow" } : {}),
      },
    });
  },

  onDeactivate(context) {
    // Unlike the old switch, where the textarea stayed open across a tool
    // switch (it rendered off `textDraft` alone, never off `activeToolId`),
    // an Overlay only renders while its tool is active — switching tools
    // unmounts it. In practice that unmount's own synchronous blur (see
    // `TextOverlay`'s `onBlur`) already commits and clears the draft before
    // this runs (`onDeactivate` fires from an effect, after the DOM update
    // that unmounted the textarea) — this is the backstop for whatever path
    // does not go through that unmount, not the primary one.
    const draft = context.state.draft;
    if (draft) commitDraft(context, draft);
    if (context.state.gesture || context.state.draft) context.setState(empty);
  },

  Overlay: TextOverlay,
};

/**
 * A native `<textarea>` positioned over the canvas in document coordinates,
 * driven entirely by `draft` — see the module doc for why typing itself is
 * not this project's code to maintain.
 */
function TextOverlay({ state, document, options, context }: { state: TextState; document: RasterDocumentState; options: Readonly<Record<string, string | number | boolean>>; context: ToolContext<TextState> }) {
  // Removing a focused textarea fires its own blur synchronously — Escape
  // and Ctrl/Cmd+Enter both clear the draft themselves and would otherwise
  // have that teardown blur run onBlur's commit a second time. Set right
  // before every such clear, and consumed (not just read) by onBlur, the
  // same guard `textCancelRef` was in the switch this replaced.
  const suppressBlurRef = useRef(false);
  const draft = state.draft;
  if (!draft) {
    const gesture = state.gesture;
    if (!gesture) return null;
    const frame = { x: Math.min(gesture.from.x, gesture.current.x), y: Math.min(gesture.from.y, gesture.current.y), width: Math.abs(gesture.current.x - gesture.from.x), height: Math.abs(gesture.current.y - gesture.from.y) };
    return <svg className="text-frame-draft" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
      <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height}/>
    </svg>;
  }

  const existingLayer = draft.layerId ? document.layers.find((item) => item.id === draft.layerId) : null;
  const draftFont = existingLayer?.text?.fontFamily ?? String(options.fontFamily ?? "Arial");
  const draftSize = existingLayer?.text?.fontSize ?? Number(options.fontSize ?? 48);
  const draftColor = existingLayer?.text?.color ?? context.foregroundColor;
  const draftAlign = (existingLayer?.text?.align ?? "left") as CSSProperties["textAlign"];
  const draftLineHeight = existingLayer?.text?.lineHeight ?? 1.2;
  const anchorX = draft.path ? Math.min(draft.path.start.x, draft.path.end.x) : draft.point.x;
  const anchorY = draft.path ? Math.min(draft.path.start.y, draft.path.end.y, draft.path.control.y) - draftSize : draft.point.y;
  const wysiwyg: CSSProperties = {
    left: anchorX, top: anchorY,
    width: draft.mode === "point" ? Math.max(160, Math.min(520, document.width - anchorX)) : Math.max(24, draft.boxWidth ?? 240),
    minHeight: draft.mode === "area" ? Math.max(24, draft.boxHeight ?? 96) : draftSize * draftLineHeight * 1.5,
    fontFamily: draftFont, fontSize: draftSize, color: draftColor, textAlign: draftAlign, lineHeight: draftLineHeight,
    fontWeight: existingLayer?.text?.bold ? 700 : 400,
    fontStyle: existingLayer?.text?.italic ? "italic" : "normal",
    textDecoration: existingLayer?.text?.underline ? "underline" : "none",
  };
  return <>
    <textarea className="canvas-text-entry" data-text-mode={draft.mode} autoFocus spellCheck={false} style={wysiwyg} value={draft.value}
      onPointerDown={(event) => event.stopPropagation()}
      onChange={(event) => context.setState({ ...state, draft: { ...draft, value: event.target.value } })}
      onBlur={() => {
        if (suppressBlurRef.current) { suppressBlurRef.current = false; return; }
        commitDraft(context, draft);
        context.setState(empty);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          suppressBlurRef.current = true;
          // Cancelling never commits — restore the ordinary composite if
          // editing an existing layer had hidden it.
          context.previewWithLayerHidden(null);
          context.setState(empty);
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          suppressBlurRef.current = true;
          commitDraft(context, draft);
          context.setState(empty);
        }
      }}
      placeholder="Type (Введите текст)"/>
    {draft.path && <svg className="text-path-guide" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`M ${draft.path.start.x} ${draft.path.start.y} Q ${draft.path.control.x} ${draft.path.control.y} ${draft.path.end.x} ${draft.path.end.y}`}/>
    </svg>}
  </>;
}

export default text;
