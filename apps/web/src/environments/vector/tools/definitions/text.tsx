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

interface Draft {
  readonly shapeId: string;
  /** What the shape held when editing began, so Escape can put it back. */
  readonly original: string;
  readonly created: boolean;
  readonly value: string;
}

export interface VectorTextState { readonly draft: Draft | null }

const empty: VectorTextState = { draft: null };

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

    const hit = shapeAtIndexed(context.spatialIndex, context.document.shapes, pointer.point.x, pointer.point.y);
    if (hit?.kind === "text") {
      context.mutate((state: VectorDocumentState) => { state.activeShapeId = hit.id; state.selection = [hit.id]; });
      context.setState({ draft: { shapeId: hit.id, original: hit.value, created: false, value: hit.value } });
      return;
    }

    // A new object starts empty rather than pre-filled with the word "Text":
    // the first thing anyone does with placeholder text is select it and delete
    // it, and an empty draft is also what makes "typed nothing, so nothing was
    // created" work.
    const shape = createShape("text", pointer.point.x, pointer.point.y, { ...emptyVectorStyle(), fills: [solidFill(cssToColor(context.foregroundColor))] });
    if (shape.kind !== "text") return;
    shape.value = "";
    shape.fontSize = typeof context.options.fontSize === "number" ? context.options.fontSize : 48;
    context.mutate((state: VectorDocumentState) => {
      addShape(state, shape);
      state.activeShapeId = shape.id;
      state.selection = [shape.id];
    });
    context.setState({ draft: { shapeId: shape.id, original: "", created: true, value: "" } });
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
          context.setState({ draft: { ...draft, value } });
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
