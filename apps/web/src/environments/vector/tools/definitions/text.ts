import { addShape, createShape } from "@vravio/env-vector";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * A single click places a text shape and commits immediately — the pre-port
 * code's own shortcut for `kind === "text"` inside the shared `shapeToolKinds`
 * branch (`draft.current = null; commitVectorDrag(...)`), pulled out into its
 * own tool now that the shared branch has split into `shape-drag.ts` and this.
 * There is no drag phase to resize during: a text shape's box is derived from
 * its string content (`shapeBounds`), not dragged out like a rectangle's.
 */
const vectorText: VectorToolDefinition<null> = {
  id: "vector.text",
  createState: () => null,

  onPointerDown(context: ToolContext<null>, pointer: ToolPointer) {
    const shape = createShape("text", pointer.point.x, pointer.point.y, { fill: context.foregroundColor, stroke: null, strokeWidth: 2, opacity: 1 });
    // "fontSize" is declared on vector.text's own option schema (default
    // 48, tools.ts) but the pre-port code never read it — createShape's own
    // canonical 32px stuck regardless of what the panel showed, the
    // dead-checkbox CLAUDE.md §3 rules out. Read here instead, falling back
    // to the *option's* default rather than createShape's differing one:
    // options bar shows 48 until the panel is touched, and a shape created
    // in that untouched state should match what it showed, not silently
    // fall through to a second, smaller default nobody sees.
    if (shape.kind === "text") shape.fontSize = typeof context.options.fontSize === "number" ? context.options.fontSize : 48;
    void context.changeDocument("New Text (Новый текст)", (draft) => { addShape(draft, shape); return true; });
  },
};

export default vectorText;
