import { createArtboardAt, moveArtboard, shapesIntersectingRect, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
import { toScreenPoint } from "../../../../vector-coordinates";
import { artboardSizeModal } from "../../../../modals/runtime";
import { FRAME_HANDLES, handleAtScreenPoint, handlePoint, resizeRectByHandle, type FrameHandle } from "../transform-frame";
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
    readonly mode: "create" | "move" | "resize";
    readonly artboardId: string;
    /** Set for a "resize" drag: which of the eight handles was caught. */
    readonly handle?: FrameHandle;
    readonly start: { readonly x: number; readonly y: number };
    readonly startRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly movers: readonly VectorShape[];
    readonly before: VectorSnapshot;
  } | null;
}

const empty: ArtboardToolState = { drag: null };

/** The active artboard's handles in screen pixels — hit-tested where they are
 * drawn, so the grab area is the same size at any zoom. Shared with the
 * selection frame's own geometry (`transform-frame.ts`) rather than a second
 * copy: a handle is a handle. */
function activeHandles(context: ToolContext<ArtboardToolState>) {
  const active = context.document.artboards.find((item) => item.id === context.document.activeArtboardId);
  if (!active) return null;
  const rect = { x: active.x, y: active.y, width: active.width, height: active.height };
  return {
    artboard: active,
    rect,
    handles: FRAME_HANDLES.map((handle) => ({ handle, point: toScreenPoint(handlePoint(rect, handle), context.workspaceSize, context.viewport, context.stageBounds) })),
  };
}

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
    const before = context.snapshot();

    // A handle first: it sits on the artboard's own edge, where the artboard
    // is as well, and a press there means resize rather than move.
    const frame = activeHandles(context);
    if (frame) {
      const pointerScreen = toScreenPoint(pointer.point, context.workspaceSize, context.viewport, context.stageBounds);
      const caught = handleAtScreenPoint(frame.handles, pointerScreen.x, pointerScreen.y);
      if (caught) {
        context.setState({ drag: { mode: "resize", artboardId: frame.artboard.id, handle: caught, start: pointer.point, startRect: frame.rect, movers: [], before } });
        return;
      }
    }

    const hit = artboardAt(context.document, pointer.point.x, pointer.point.y);

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

    if (drag.mode === "resize" && drag.handle) {
      // The dragged edge follows the pointer while the opposite one stays put,
      // computed from the rectangle the drag started with rather than from the
      // rectangle as it is now — measuring against something this same drag is
      // changing is how a resize runs away from the pointer. A side handle moves
      // one edge only.
      const rect = resizeRectByHandle(drag.startRect, drag.handle, pointer.point);
      context.mutate((draft) => {
        const artboard = draft.artboards.find((item) => item.id === drag.artboardId);
        if (artboard) { artboard.x = rect.x; artboard.y = rect.y; artboard.width = rect.width; artboard.height = rect.height; }
      });
      return;
    }

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

  onGestureEnd(context: ToolContext<ArtboardToolState>, pointer: ToolPointer) {
    const drag = context.state.drag;
    context.setState(empty);
    if (!drag) return;

    // A click that never became a drag asks for the size instead of leaving a
    // zero-sized artboard behind — the owner's request, and the more useful
    // half of the gesture: dragging is how a layout is found, typing is how a
    // known size (1920x1080, A4) is specified.
    if (drag.mode === "create" && Math.abs(pointer.point.x - drag.start.x) < 2 && Math.abs(pointer.point.y - drag.start.y) < 2) {
      void artboardSizeModal({ width: 1920, height: 1080 }).then((size) => {
        void context.changeDocument("Create Artboard (Создать монтажную область)", (draft) => {
          const artboard = draft.artboards.find((item) => item.id === drag.artboardId);
          if (!artboard) return false;
          // Dismissed: the placeholder the press created goes away with it,
          // rather than staying as a zero-sized artboard nothing can click.
          if (!size) { draft.artboards = draft.artboards.filter((item) => item.id !== drag.artboardId); if (draft.activeArtboardId === drag.artboardId) draft.activeArtboardId = draft.artboards[draft.artboards.length - 1]?.id ?? null; return true; }
          // Centred on the click, which is where the user pointed.
          artboard.x = drag.start.x - size.width / 2;
          artboard.y = drag.start.y - size.height / 2;
          artboard.width = size.width;
          artboard.height = size.height;
          draft.activeArtboardId = artboard.id;
          return true;
        });
      });
      return;
    }
    context.commitDrag(drag.before, drag.mode === "create" ? "Create Artboard (Создать монтажную область)" : drag.mode === "resize" ? "Resize Artboard (Изменить размер монтажной области)" : "Move Artboard (Переместить монтажную область)");
  },

  onDeactivate(context: ToolContext<ArtboardToolState>) {
    context.setState(empty);
  },

  ScreenOverlay({ context }) {
    // Only the handles are drawn here. Every artboard's rectangle, label and
    // active border are host chrome in VectorWorkspace.tsx — an artboard is part
    // of what the canvas is, visible under every tool — but a *handle* is this
    // tool's, since only this tool can drag one. Screen space, so the squares
    // are the same size at any zoom and are hit-tested where they are drawn.
    const frame = activeHandles(context);
    if (!frame) return null;
    return <>{frame.handles.map(({ handle, point }) => (
      <rect key={`${handle.x},${handle.y}`} className="vector-handle" x={point.x - 4} y={point.y - 4} width={8} height={8}/>
    ))}</>;
  },

  // No Overlay: every artboard's own rectangle, label and active-highlight
  // border render unconditionally in VectorWorkspace.tsx (host chrome, the
  // same reason the selection outline is not a tool Overlay either) — an
  // artboard is part of what the canvas *is*, visible under every tool,
  // not a drawing this one tool contributes on top of it.
};

export default artboardTool;
