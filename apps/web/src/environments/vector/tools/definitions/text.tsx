import { addShape, createShape, emptyVectorStyle, removeShapes, shapeAtIndexed, solidFill, updateShape, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
import { cssToColor } from "@vravio/kernel";
import { useRef } from "react";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * The Type tool: click and type.
 *
 * What this replaces placed a text shape reading "Text (Текст)" and committed
 * on the spot — there was no way to type at all, which is the whole of the
 * owner's "текст в растре работает во много раз лучше, чем в векторе". Raster's
 * own text tool has had the answer since it was ported, and it is the same one
 * Illustrator and Inkscape use: a real `<textarea>` sitting over the canvas, in
 * the document's own coordinates, wearing the shape's font.
 *
 * A native textarea rather than a hand-drawn caret because typing is more than
 * letters — a caret that blinks in the right place, selection, Home/End, undo
 * inside the field, an IME for languages that need one, the OS's own spell
 * check. Rebuilding that on top of an SVG overlay is a project; borrowing it is
 * a `<foreignObject>`. (Raster's own text tool says the same thing about the
 * same decision.)
 *
 * Click on empty canvas starts a new text object; click on an existing one
 * opens it for editing, which is what the Type tool does everywhere. Escape
 * ends editing, and a text object left empty is removed rather than kept as an
 * invisible shape nothing can select.
 */

/** A press in progress. The draft — and with it the textarea — is opened only when this ends,
 * never on the press itself: a field focused during `pointerdown` loses that focus again the
 * moment the browser applies the press's own default focus to the canvas underneath, and the
 * blur that follows finishes the edit before a single character can be typed. An empty edit
 * removes its shape, so the visible result was a Type tool that created nothing at all.
 * Raster's Type tool has always done it this way (`raster/tools/definitions/text.tsx` opens its
 * draft in `onGestureEnd`); this file was the one that did not. */
interface Gesture {
  readonly from: { x: number; y: number };
  readonly current: { x: number; y: number };
  readonly pointerId: number;
}

interface Draft {
  readonly shapeId: string;
  /** What the shape held when editing began, so Escape can put it back. */
  readonly original: string;
  readonly created: boolean;
  readonly value: string;
}

export interface VectorTextState { readonly draft: Draft | null; readonly gesture: Gesture | null }

const empty: VectorTextState = { draft: null, gesture: null };

/** Below this a drag is a click — the same 4px raster's Type tool uses. */
const DRAG_THRESHOLD = 4;

function applyValue(context: ToolContext<VectorTextState>, draft: Draft, value: string): void {
  context.mutate((state: VectorDocumentState) => {
    const shape = state.shapes.find((item) => item.id === draft.shapeId);
    if (shape?.kind === "text") shape.value = value;
  });
}

/** Ends editing: an empty text object is taken away, anything else is kept with
 * one history entry for the whole edit rather than one per keystroke. */
function finish(context: ToolContext<VectorTextState>, draft: Draft, value: string): void {
  const trimmed = value.trim();
  void context.changeDocument(draft.created ? "New Text (Новый текст)" : "Edit Text (Изменить текст)", (state) => {
    const shape = state.shapes.find((item) => item.id === draft.shapeId);
    if (!shape || shape.kind !== "text") return false;
    if (!trimmed) { removeShapes(state, [draft.shapeId]); state.activeShapeId = null; state.selection = []; return true; }
    updateShape<Extract<VectorShape, { kind: "text" }>>(state, draft.shapeId, { value });
    return true;
  });
  context.setState(empty);
}

const vectorText: VectorToolDefinition<VectorTextState> = {
  id: "vector.text",
  createState: () => empty,

  onPointerDown(context: ToolContext<VectorTextState>, pointer: ToolPointer) {
    const current = context.state.draft;
    if (current) { finish(context, current, current.value); return; }
    context.setState({ draft: null, gesture: { from: pointer.point, current: pointer.point, pointerId: pointer.pointerId } });
  },

  onPointerMove(context: ToolContext<VectorTextState>, pointer: ToolPointer) {
    const gesture = context.state.gesture;
    if (!gesture || gesture.pointerId !== pointer.pointerId) return;
    context.setState({ ...context.state, gesture: { ...gesture, current: pointer.point } });
  },

  onGestureEnd(context: ToolContext<VectorTextState>, pointer: ToolPointer) {
    const gesture = context.state.gesture;
    if (!gesture || gesture.pointerId !== pointer.pointerId) return;

    const hit = shapeAtIndexed(context.spatialIndex, context.document.shapes, gesture.from.x, gesture.from.y);
    if (hit?.kind === "text") {
      context.mutate((state: VectorDocumentState) => { state.activeShapeId = hit.id; state.selection = [hit.id]; });
      context.setState({ gesture: null, draft: { shapeId: hit.id, original: hit.value, created: false, value: hit.value } });
      return;
    }

    // Click makes point text, drag makes area text of the width dragged — Illustrator's and
    // Inkscape's split, and the one raster's own Type tool already makes between its "point"
    // and "area" modes. Area text wraps inside its frame; point text only breaks where the
    // typist breaks it.
    const dragged = Math.hypot(gesture.current.x - gesture.from.x, gesture.current.y - gesture.from.y) >= DRAG_THRESHOLD;
    const left = Math.min(gesture.from.x, gesture.current.x), top = Math.min(gesture.from.y, gesture.current.y);
    const fontSize = typeof context.options.fontSize === "number" ? context.options.fontSize : 48;

    // A new object starts empty rather than pre-filled with the word "Text": the first thing
    // anyone does with placeholder text is select it and delete it, and an empty draft is also
    // what makes "typed nothing, so nothing was created" work.
    const origin = dragged ? { x: left, y: top + fontSize } : gesture.from;
    const shape = createShape("text", origin.x, origin.y, { ...emptyVectorStyle(), fills: [solidFill(cssToColor(context.foregroundColor))] });
    if (shape.kind !== "text") return;
    shape.value = "";
    shape.fontSize = fontSize;
    if (dragged) shape.frameWidth = Math.max(fontSize, Math.abs(gesture.current.x - gesture.from.x));
    context.mutate((state: VectorDocumentState) => {
      addShape(state, shape);
      state.activeShapeId = shape.id;
      state.selection = [shape.id];
    });
    context.setState({ gesture: null, draft: { shapeId: shape.id, original: "", created: true, value: "" } });
  },
  onDeactivate(context: ToolContext<VectorTextState>) {
    const draft = context.state.draft;
    if (draft) finish(context, draft, draft.value);
    else context.setState(empty);
  },

  Overlay({ state, document, context }) {
    const draft = state.draft;
    // Escape and blur both end the edit; without this the teardown blur that
    // follows Escape would run the finish a second time. (The same guard
    // raster's text tool keeps, for the same reason.)
    const endingRef = useRef(false);
    if (!draft) return null;
    const shape = document.shapes.find((item) => item.id === draft.shapeId);
    if (!shape || shape.kind !== "text") return null;

    const lineHeight = 1.2;
    const width = shape.frameWidth ?? Math.max(shape.fontSize * 8, 200);
    const height = Math.max(shape.fontSize * lineHeight * 1.4, (draft.value.split("\n").length + 0.4) * shape.fontSize * lineHeight);
    // Document coordinates, like every other Overlay here: the stage's own
    // transform then scales the field with the artwork, so what is typed is the
    // size it will be. The box is placed a line above the baseline, because a
    // text shape's y is its baseline and a textarea's is its top edge.
    return <foreignObject x={shape.x} y={shape.y - shape.fontSize} width={width} height={height} style={{ overflow: "visible" }}>
      <textarea
        className="canvas-text-entry" data-text-mode={shape.frameWidth ? "area" : "point"}
        autoFocus spellCheck={false} value={draft.value}
        style={{
          width: "100%", height: "100%",
          fontFamily: shape.fontFamily, fontSize: shape.fontSize, lineHeight,
          textAlign: shape.align, color: context.foregroundColor,
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => {
          const value = event.target.value;
          context.setState({ gesture: null, draft: { ...draft, value } });
          // The shape follows every keystroke, so the canvas under the field
          // shows the real object rather than a preview of one.
          applyValue(context, draft, value);
        }}
        onBlur={() => {
          if (endingRef.current) { endingRef.current = false; return; }
          finish(context, draft, draft.value);
        }}
        onKeyDown={(event) => {
          // Kept from reaching the workspace: every letter here is text, not a
          // tool shortcut.
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            endingRef.current = true;
            applyValue(context, draft, draft.original);
            finish(context, { ...draft, value: draft.original }, draft.original);
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            // Ctrl/Cmd+Enter finishes; plain Enter is a new line, which is what
            // Enter means inside text everywhere.
            event.preventDefault();
            endingRef.current = true;
            finish(context, draft, draft.value);
          }
        }}
      />
    </foreignObject>;
  },
};

export default vectorText;
