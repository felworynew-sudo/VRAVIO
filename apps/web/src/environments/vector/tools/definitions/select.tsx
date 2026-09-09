import { invertMatrix, resolveSnapForBounds, scaleShapes, shapeAtIndexed, shapeWorldBounds, shapeWorldBoundsIndexed, transformVector, translateShape, visibleGuides, worldTransform, type SnapLine, type VectorBounds, type VectorDocumentState, type VectorShape } from "@vravio/env-vector";
import { toScreenPoint } from "../../../../vector-coordinates";
import { constrainToAxis, rectBetween, rectsOverlap, resolveMarqueeRelease, resolveSelectionPress } from "../selection-rules";
import { FRAME_HANDLES, anchorPoint, handleAtScreenPoint, handlePoint, scaleForHandleDrag, unionBounds, type FrameHandle } from "../transform-frame";
import type { VectorSnapshot } from "../../../../vector-commands";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * Picks the topmost shape under the pointer and drags it — the pre-port
 * code's fall-through "Select tool" branch at the bottom of `onPointerDown`,
 * which `vector.nodes` also fell into whenever the click missed a node (see
 * `nodes.ts`). Clicking empty space deselects without a history step,
 * matching how a raster marquee click doesn't push an undo entry either —
 * "what is selected" has never itself been an undoable edit in this project.
 */
export interface SelectState {
  /** Every selected shape moves, not just the one the pointer landed on — the
   * raster Move tool has always moved the whole selection, and a vector editor
   * that moves one object out of five is the odd one out, not the careful one. */
  readonly drag: { readonly shapeIds: readonly string[]; readonly start: { readonly x: number; readonly y: number }; readonly before: VectorSnapshot } | null;
  /** A live drag of one of the frame's eight handles. `applied` is the scale
   * already written into the document, so each frame can apply only the part
   * that is new — every scale is about the same fixed anchor, so they compose
   * exactly and the box never drifts from where the pointer says it is. */
  readonly resize: { readonly handle: FrameHandle; readonly ids: readonly string[]; readonly startBounds: VectorBounds; readonly anchor: { readonly x: number; readonly y: number }; readonly applied: { readonly x: number; readonly y: number }; readonly before: VectorSnapshot } | null;
  /** The rubber band, while one is being dragged from empty space. */
  readonly marquee: { readonly from: { readonly x: number; readonly y: number }; readonly to: { readonly x: number; readonly y: number }; readonly additive: boolean; readonly selectionAtPress: readonly string[] } | null;
  /** The line(s) the current drag is snapped to, for the Overlay to
   * highlight — docs/vector-plan.md stage 5's "подсветка того, к чему
   * привязались", without which a snap looks like the editor nudging a
   * shape on its own for no visible reason. */
  readonly snapLines: readonly SnapLine[];
}

const empty: SelectState = { drag: null, resize: null, marquee: null, snapLines: [] };

/** Shared by `vector.select` and `vector.nodes`' own fallback (see `nodes.ts`) — the
 * exact pre-port "pick a shape, start a move drag, or deselect" tail. */
export function beginSelectDrag(context: ToolContext<SelectState>, pointer: ToolPointer): void {
  const hit = shapeAtIndexed(context.spatialIndex, context.document.shapes, pointer.point.x, pointer.point.y);
  const selection = context.document.selection ?? [];
  const decision = resolveSelectionPress(hit?.id ?? null, selection, pointer.shiftKey);

  if (!hit) {
    // Empty space rubber-bands. Nothing is deselected yet: the band decides on
    // release, so a drag that starts badly and is dragged onto the objects
    // still ends up selecting them.
    context.setState({ drag: null, resize: null, marquee: { from: pointer.point, to: pointer.point, additive: pointer.shiftKey, selectionAtPress: selection }, snapLines: [] });
    return;
  }

  const next = decision.selection;
  context.mutate((draft: VectorDocumentState) => {
    draft.selection = [...next];
    // The active shape is the one just clicked while it is still selected;
    // shift-clicking a shape *off* hands the role to whatever remains, so the
    // panels never point at something the canvas no longer shows as selected.
    draft.activeShapeId = next.includes(hit.id) ? hit.id : next[next.length - 1] ?? null;
  });
  if (!decision.drag) { context.setState(empty); return; }
  context.setState({ drag: { shapeIds: next.length ? next : [hit.id], start: pointer.point, before: context.snapshot() }, resize: null, marquee: null, snapLines: [] });
}

/** The chain of parent group ids above a shape — excluded from its own snap
 * candidates alongside the shape itself, since a group's bounds are the
 * union of its children's (`shapeWorldBounds`'s own handling) and would
 * otherwise shift together with the very shape being dragged, chasing its
 * own tail instead of offering a stable target. */
function ancestorIds(shape: VectorShape, shapes: readonly VectorShape[]): string[] {
  const ids: string[] = [];
  let parentId = shape.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    ids.push(parentId);
    parentId = shapes.find((candidate) => candidate.id === parentId)?.parentId ?? null;
  }
  return ids;
}

/** The one frame a selection gets: the union of every selected shape's world
 * bounds, so several objects sit inside a single box rather than each carrying
 * its own — which is what the owner asked for, and what every vector editor
 * does. */
export function selectionFrameBounds(context: ToolContext<SelectState>): VectorBounds | null {
  const ids = context.document.selection?.length ? context.document.selection : (context.document.activeShapeId ? [context.document.activeShapeId] : []);
  if (!ids.length) return null;
  const boxes = ids
    .map((id) => shapeWorldBoundsIndexed(context.spatialIndex, id) ?? (() => {
      const shape = context.document.shapes.find((item) => item.id === id);
      return shape ? shapeWorldBounds(shape, context.document.shapes) : null;
    })())
    .filter((bounds): bounds is VectorBounds => Boolean(bounds));
  return unionBounds(boxes);
}

/** The frame's handles in screen pixels, which is where they are hit-tested and
 * drawn — both need the same list, and computing it twice is how the two drift. */
function screenHandles(context: ToolContext<SelectState>, bounds: VectorBounds) {
  return FRAME_HANDLES.map((handle) => ({
    handle,
    point: toScreenPoint(handlePoint(bounds, handle), context.workspaceSize, context.viewport, context.stageBounds),
  }));
}

const select: VectorToolDefinition<SelectState> = {
  id: "vector.select",
  createState: () => empty,

  onPointerDown(context: ToolContext<SelectState>, pointer: ToolPointer) {
    // A handle is checked before the shape under the pointer: it sits on the
    // selection's own edge, where a shape usually is too, and a press there
    // means "resize this" rather than "pick whatever is underneath".
    if (context.options.transform !== false) {
      const bounds = selectionFrameBounds(context);
      const ids = context.document.selection ?? [];
      if (bounds && ids.length) {
        // The pointer is converted through the same `toScreenPoint` as the
        // handles rather than compared against `pointer.screenX`: that is
        // `event.clientX`, measured from the window, while a handle's position is
        // measured from the workspace element — different origins by the width of
        // the tool rail and the height of the bars above, so the two never met and
        // no handle was ever caught (found live, by dragging one and watching
        // nothing happen).
        const pointerScreen = toScreenPoint(pointer.point, context.workspaceSize, context.viewport, context.stageBounds);
        const caught = handleAtScreenPoint(screenHandles(context, bounds), pointerScreen.x, pointerScreen.y);
        if (caught) {
          context.setState({
            drag: null,
            resize: { handle: caught, ids: [...ids], startBounds: bounds, anchor: anchorPoint(bounds, caught), applied: { x: 1, y: 1 }, before: context.snapshot() },
            marquee: null, snapLines: [],
          });
          return;
        }
      }
    }
    beginSelectDrag(context, pointer);
  },

  onPointerMove(context: ToolContext<SelectState>, pointer: ToolPointer) {
    const resize = context.state.resize;
    if (resize) {
      // The total scale is always measured from the box the drag started with,
      // never from the box as it is now: measuring against a box this same drag
      // has been changing is how a resize accelerates away from the pointer.
      // Only the part not yet applied is written, and since every scale is about
      // the same fixed anchor they compose exactly.
      const total = scaleForHandleDrag(resize.startBounds, resize.handle, pointer.point, pointer.shiftKey);
      const step = { x: total.x / resize.applied.x, y: total.y / resize.applied.y };
      if (Number.isFinite(step.x) && Number.isFinite(step.y) && (step.x !== 1 || step.y !== 1)) {
        context.mutate((draft: VectorDocumentState) => { scaleShapes(draft, resize.ids, resize.anchor, step.x, step.y); });
      }
      context.setState({ ...context.state, resize: { ...resize, applied: total } });
      return;
    }
    const marquee = context.state.marquee;
    if (marquee) { context.setState({ ...context.state, marquee: { ...marquee, to: pointer.point } }); return; }
    const drag = context.state.drag;
    if (!drag) return;
    const constrained = constrainToAxis(pointer.point.x - drag.start.x, pointer.point.y - drag.start.y, pointer.shiftKey);
    const dx = constrained.x, dy = constrained.y;

    let snapLines: readonly SnapLine[] = [];
    context.mutate((draft: VectorDocumentState) => {
      // The first selected shape leads: it is the one snapping is resolved
      // against, and every other selected shape takes the same world delta, so
      // a group of objects keeps its arrangement instead of each member
      // snapping to something different.
      const shape = draft.shapes.find((item) => item.id === drag.shapeIds[0]);
      if (!shape) return;
      const world = worldTransform(shape, draft.shapes);
      const inverse = invertMatrix(world);

      // The naive move's effect in world space — for a top-level shape
      // (identity transform, the common case) this is just (dx, dy); for a
      // shape inside a scaled or rotated group it is not, which is exactly
      // why this is computed rather than assumed.
      const worldDelta = transformVector(world, { x: dx, y: dy });
      const currentWorldBounds = shapeWorldBounds(shape, draft.shapes);
      const projectedBounds = { x: currentWorldBounds.x + worldDelta.x, y: currentWorldBounds.y + worldDelta.y, width: currentWorldBounds.width, height: currentWorldBounds.height };

      // Nothing in the moving set is a snap candidate: a shape cannot snap to
      // another shape travelling with it by the same delta.
      const excludeIds = new Set([...drag.shapeIds, ...drag.shapeIds.flatMap((id) => {
        const member = draft.shapes.find((item) => item.id === id);
        return member ? ancestorIds(member, draft.shapes) : [];
      })]);
      // `drag.snapLines` (this same drag's previous frame) makes the snap
      // sticky — see resolveSnapForBounds's own doc comment for why a
      // dragged shape otherwise visibly jumps between near-tied candidate
      // lines on every tiny mouse movement.
      const snap = resolveSnapForBounds(projectedBounds, context.snapping.radius, context.snapping.sources, {
        shapes: draft.shapes, excludeIds, gridSpacing: context.snapping.gridSpacing,
        documentWidth: draft.width, documentHeight: draft.height, guides: visibleGuides(draft, draft.activeArtboardId),
      }, context.state.snapLines);
      snapLines = snap.lines;

      const totalWorldDelta = { x: worldDelta.x + snap.dx, y: worldDelta.y + snap.dy };
      // Snapping is meaningless for a shape whose transform cannot be
      // inverted (a zero-scale ancestor) — the naive move still applies,
      // it just never snaps, the same fallback shapeAt's own inverse check
      // already uses.
      const localDelta = inverse ? transformVector(inverse, totalWorldDelta) : { x: dx, y: dy };
      translateShape(draft, shape.id, localDelta.x, localDelta.y);

      // Everyone else takes the same *world* delta, converted through their own
      // parent transform — a member inside a scaled or rotated group needs a
      // different local delta to travel the same distance on screen. A shape
      // whose ancestor is also moving is skipped: translating the group already
      // carried it, and moving it again would double its travel.
      for (const id of drag.shapeIds.slice(1)) {
        const member = draft.shapes.find((item) => item.id === id);
        if (!member) continue;
        if (ancestorIds(member, draft.shapes).some((ancestorId) => drag.shapeIds.includes(ancestorId))) continue;
        const memberInverse = invertMatrix(worldTransform(member, draft.shapes));
        const memberDelta = memberInverse ? transformVector(memberInverse, totalWorldDelta) : { x: dx, y: dy };
        translateShape(draft, member.id, memberDelta.x, memberDelta.y);
      }
    });
    // `start` moves to the raw pointer, not to the constrained point: the
    // constraint is applied to the whole gesture each frame, so releasing Shift
    // mid-drag returns the shape to where the pointer actually is.
    context.setState({ drag: { ...drag, start: pointer.point }, resize: null, marquee: null, snapLines });
  },

  onGestureEnd(context: ToolContext<SelectState>, pointer: ToolPointer) {
    const { drag, resize, marquee } = context.state;
    context.setState(empty);
    if (resize) { context.commitDrag(resize.before, "Scale Selection (Масштабировать выделение)"); return; }
    if (drag) { context.commitDrag(drag.before, "Move Shape (Переместить фигуру)"); return; }
    if (!marquee) return;

    const band = rectBetween(marquee.from, pointer.point);
    // A press that never travelled is a click on empty space, and that clears
    // the selection — Photoshop's behaviour, and the pre-port behaviour of this
    // file. Anything wider than a hair is a band.
    const dragged = band.width > 1 || band.height > 1;
    const caught = dragged
      ? context.document.shapes
        // The same things a click can select: leaf shapes, visible and unlocked.
        // (Artboards are not shapes in this model, so there is nothing to exclude
        // for them here.)
        // Filtering on `parentId === null` instead looked reasonable and was
        // wrong — a shape drawn on an artboard is parented to it, so a band over
        // a normal document caught nothing at all (found live, not by reading).
        .filter((shape) => shape.kind !== "group" && shape.visible !== false && !shape.locked)
        .filter((shape) => {
          const bounds = shapeWorldBoundsIndexed(context.spatialIndex, shape.id) ?? shapeWorldBounds(shape, context.document.shapes);
          return bounds.width >= 0 && rectsOverlap(band, bounds);
        })
        .map((shape) => shape.id)
      : [];
    const next = resolveMarqueeRelease(caught, marquee.selectionAtPress, marquee.additive);
    context.mutate((draft: VectorDocumentState) => {
      draft.selection = [...next];
      draft.activeShapeId = next[next.length - 1] ?? null;
    });
  },

  onDeactivate(context: ToolContext<SelectState>) {
    context.setState(empty);
  },

  ScreenOverlay({ state, options, context }) {
    const marquee = state.marquee;
    if (!marquee) {
      // The selection frame. Drawn here rather than by the workspace because it
      // belongs to this tool: it is the chrome for moving and scaling, so the
      // node and pen tools never show it, and its handles are hit-tested by the
      // same file that draws them. One box for the whole selection, however
      // many objects are in it.
      if (options.transform === false) return null;
      const bounds = selectionFrameBounds(context);
      if (!bounds) return null;
      const corners = [
        { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height },
      ].map((point) => toScreenPoint(point, context.workspaceSize, context.viewport, context.stageBounds));
      return <>
        <polygon className="vector-selection" points={corners.map((corner) => `${corner.x},${corner.y}`).join(" ")}/>
        {screenHandles(context, bounds).map(({ handle, point }) => (
          <rect key={`${handle.x},${handle.y}`} className="vector-handle" x={point.x - 4} y={point.y - 4} width={8} height={8}/>
        ))}
      </>;
    }
    const from = toScreenPoint(marquee.from, context.workspaceSize, context.viewport, context.stageBounds);
    const to = toScreenPoint(marquee.to, context.workspaceSize, context.viewport, context.stageBounds);
    const band = rectBetween(from, to);
    if (band.width < 1 && band.height < 1) return null;
    // Screen space, so the band's outline is a literal 1px however far the
    // document is zoomed — there is no scale on this layer to divide out. The
    // dashed thin rectangle is what Photoshop draws while a selection band is
    // being dragged.
    return <rect className="vector-marquee-band" x={band.x} y={band.y} width={band.width} height={band.height}/>;
  },

  Overlay({ state, document, context }) {
    // Full-canvas lines at the matched value(s) — docs/vector-plan.md stage
    // 5's "подсветка того, к чему привязались": without this, a shape
    // snapping into place looks like the editor nudging it on its own for
    // no visible reason. Drawn only while a drag is live and something
    // actually matched (`state.snapLines` is empty otherwise), same as
    // vector.nodes' handles only appear while there is a node to show them
    // for.
    //
    // `strokeWidth={1 / context.viewport.zoom}` rather than
    // `vectorEffect="non-scaling-stroke"` alone (this file used to rely on
    // that alone, and it was measurably wrong at high zoom) — dividing by
    // zoom here means the CSS scale transform on `.vector-stage` multiplies
    // it straight back to exactly 1 real screen pixel, which is arithmetic,
    // not a browser feature that may or may not compensate for an ancestor's
    // CSS transform (see `types.ts`'s own doc comment on `Overlay`, and
    // `VectorWorkspace.tsx`'s selection handles, which already use this
    // exact convention for the same reason).
    if (!state.drag || !state.snapLines.length) return null;
    const strokeWidth = 1 / context.viewport.zoom;
    return <>{state.snapLines.map((line, index) => line.axis === "x"
      ? <line key={index} className="vector-snap-guide" x1={line.value} y1={0} x2={line.value} y2={document.height} strokeWidth={strokeWidth} strokeDasharray={`${4 * strokeWidth} ${3 * strokeWidth}`}/>
      : <line key={index} className="vector-snap-guide" x1={0} y1={line.value} x2={document.width} y2={line.value} strokeWidth={strokeWidth} strokeDasharray={`${4 * strokeWidth} ${3 * strokeWidth}`}/>)}</>;
  },
};

export default select;
