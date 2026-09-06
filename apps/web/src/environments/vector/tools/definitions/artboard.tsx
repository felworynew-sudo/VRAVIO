import { createArtboardAt, moveArtboard, shapesIntersectingRect, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
import type { VectorSnapshot } from "../../../../vector-commands";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * Stage 15 of docs/vector-plan.md: the Artboard tool — Illustrator's own
 * `Shift+O`, here on plain `B` (this project's tool shortcuts are single
 * letters with no modifier, and `O` is already Ellipse). Three gestures
 * share one drag state: drag on empty canvas creates a new artboard sized
 * by the drag itself; drag starting inside an existing artboard's own
 * rectangle moves it (and, with "Move/Copy Artwork with Artboard" on,
 * every top-level shape that overlapped it at the *start* of the drag —
 * `artboard-ops.ts`'s own `moveArtboard`); clicking an artboard without
 * dragging just makes it the active one, the same "selecting is not an
 * undoable edit" convention `vector.select`'s own click already follows.
 */
export interface ArtboardToolState {
  readonly drag: {
    readonly mode: "create" | "move";
    readonly artboardId: string;
    readonly start: { readonly x: number; readonly y: number };
    readonly startRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly movers: readonly VectorShape[];
    readonly before: VectorSnapshot;
  } | null;
}

const empty: ArtboardToolState = { drag: null };

function artboardAt(document: VectorDocumentState, x: number, y: number) {
  for (let index = document.artboards.length - 1; index >= 0; index -= 1) {
    const artboard = document.artboards[index]!;
    if (x >= artboard.x && x <= artboard.x + artboard.width && y >= artboard.y && y <= artboard.y + artboard.height) return artboard;
  }
  return null;
}

const artboardTool: VectorToolDefinition<ArtboardToolState> = {
  id: "vector.artboard",
  createState: () => empty,

  onPointerDown(context: ToolContext<ArtboardToolState>, pointer: ToolPointer) {
    const hit = artboardAt(context.document, pointer.point.x, pointer.point.y);
    const before = context.snapshot();

    if (hit) {
      const moveArtwork = context.options.moveArtwork === true;
      const movers = moveArtwork ? shapesIntersectingRect(context.document, hit) : [];
      context.mutate((draft) => { draft.activeArtboardId = hit.id; });
      context.setState({ drag: { mode: "move", artboardId: hit.id, start: pointer.point, startRect: { x: hit.x, y: hit.y, width: hit.width, height: hit.height }, movers, before } });
      return;
    }

    let createdId = "";
    context.mutate((draft) => { createdId = createArtboardAt(draft, pointer.point.x, pointer.point.y, 0, 0).id; });
    context.setState({ drag: { mode: "create", artboardId: createdId, start: pointer.point, startRect: { x: pointer.point.x, y: pointer.point.y, width: 0, height: 0 }, movers: [], before } });
  },

  onPointerMove(context: ToolContext<ArtboardToolState>, pointer: ToolPointer) {
    const drag = context.state.drag;
    if (!drag) return;

    if (drag.mode === "create") {
      const x = Math.min(drag.start.x, pointer.point.x), y = Math.min(drag.start.y, pointer.point.y);
      const width = Math.abs(pointer.point.x - drag.start.x), height = Math.abs(pointer.point.y - drag.start.y);
      context.mutate((draft) => {
        const artboard = draft.artboards.find((item) => item.id === drag.artboardId);
        if (artboard) { artboard.x = x; artboard.y = y; artboard.width = width; artboard.height = height; }
      });
      return;
    }

    // "move": reset the artboard (and every shape moving with it) back to
    // the drag's own starting snapshot before re-applying the *cumulative*
    // delta from `drag.start` — the same reason a shape drag always
    // recomputes from its own gesture start rather than compounding one
    // more small move onto whatever the previous pointermove already did.
    context.mutate((draft) => {
      const artboard = draft.artboards.find((item) => item.id === drag.artboardId);
      if (artboard) { artboard.x = drag.startRect.x; artboard.y = drag.startRect.y; artboard.width = drag.startRect.width; artboard.height = drag.startRect.height; }
      for (const mover of drag.movers) {
        const original = drag.before.shapes.find((item) => item.id === mover.id);
        const live = draft.shapes.find((item) => item.id === mover.id);
        if (original && live) Object.assign(live, structuredClone(original));
      }
      moveArtboard(draft, drag.artboardId, pointer.point.x - drag.start.x, pointer.point.y - drag.start.y, drag.movers.length > 0, drag.movers);
    });
  },

  onGestureEnd(context: ToolContext<ArtboardToolState>) {
    const drag = context.state.drag;
    context.setState(empty);
    if (!drag) return;
    context.commitDrag(drag.before, drag.mode === "create" ? "Create Artboard (Создать монтажную область)" : "Move Artboard (Переместить монтажную область)");
  },

  onDeactivate(context: ToolContext<ArtboardToolState>) {
    context.setState(empty);
  },

  // No Overlay: every artboard's own rectangle, label and active-highlight
  // border render unconditionally in VectorWorkspace.tsx (host chrome, the
  // same reason the selection outline is not a tool Overlay either) — an
  // artboard is part of what the canvas *is*, visible under every tool,
  // not a drawing this one tool contributes on top of it.
};

export default artboardTool;
