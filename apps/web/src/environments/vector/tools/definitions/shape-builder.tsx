import { useEffect } from "react";
import { addShape, buildShapeBuilderFaces, faceContainsPoint, pathShapeFromPolygon, removeShapes, shapeOutlineWorldPolygon, unionFaces, type ShapeBuilderFace, type VectorShape, type VectorStyle } from "@vravio/env-vector";
import { getSharedGeometryPort } from "../../../../vector-commands";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * Illustrator's/Inkscape's Shape Builder — real behaviour read from
 * Inkscape's own source before writing anything here (CLAUDE.md §1, and
 * the owner's own direct instruction to check open source first): the
 * fracture-into-faces algorithm and its rationale live in
 * `packages/env-vector/src/shape-builder.ts`'s own doc comment (the
 * `booleans-tool.cpp`/`booleans-subitems.cpp` citations are there, not
 * repeated here). This file is only the interactive half: hover
 * highlights the face under the pointer, a plain drag merges every face it
 * crosses into one shape, `Alt`-drag erases every face it crosses instead
 * — Inkscape's own two modes (`InteractiveBooleansTool::shape_commit`'s
 * `TaskType::ADD`/`TaskType::DELETE`).
 *
 * Faces are computed once, lazily, the first time the tool becomes active
 * with two or more selected shapes that have a usable fill outline — not
 * on every render, since each new shape in the fracture costs a handful of
 * WASM boolean-op calls (`buildShapeBuilderFaces`'s own doc comment). They
 * are thrown away again on deactivate, so switching away and back (or
 * changing the selection first) always fractures fresh rather than working
 * from a stale decomposition of a selection that no longer matches.
 */
export interface ShapeBuilderState {
  /** `null` before the fracture has run (or after `onDeactivate` threw the
   * previous one away); an empty array is a real, computed "nothing to
   * build" answer (fewer than two usable outlines), distinct from "not
   * computed yet" — the same "don't conflate two different kinds of
   * nothing" lesson CLAUDE.md §4 states for a `null` clipboard read. */
  readonly faces: readonly ShapeBuilderFace[] | null;
  /** Every original selected shape's own style, captured once alongside
   * the faces — a face only ever remembers *ids*, not style objects, so a
   * kept or merged result can still recover "what did this used to look
   * like" without re-reading a `document.shapes` array that has, by the
   * time of commit, already had those shapes removed. */
  readonly styleById: ReadonlyMap<string, VectorStyle>;
  /** The original selection, topmost shape first — `sourceIds[0]` of any
   * face only ever names the topmost owner *of that face*; picking a style
   * for a merge spanning several faces with different topmost owners needs
   * this list to know which of them is topmost overall. */
  readonly orderedSourceIds: readonly string[];
  readonly hovered: number | null;
  /** Set once a drag begins (`Alt` decides which mode) and grows with every
   * new face the pointer crosses; `null` when no drag is in progress. */
  readonly drag: { readonly touched: ReadonlySet<number>; readonly erasing: boolean } | null;
}

const empty: ShapeBuilderState = { faces: null, styleById: new Map(), orderedSourceIds: [], hovered: null, drag: null };

function faceAt(faces: readonly ShapeBuilderFace[], x: number, y: number): number | null {
  // Reverse order: a later-built face (deeper into the fracture, i.e. a
  // smaller, more specific overlap region) is drawn on top and should win
  // a click over an earlier, larger one that happens to also contain the
  // point — mirroring how `shapeAt`'s own topmost-first search works for
  // ordinary shapes.
  for (let index = faces.length - 1; index >= 0; index -= 1) {
    if (faceContainsPoint(faces[index]!.polygon, x, y)) return index;
  }
  return null;
}

/** Commits the current drag (if any): merges every touched face into one
 * shape (default) or deletes them all (`Alt`), keeping every untouched
 * face as its own shape styled the way its original owner looked. Exported
 * for `onGestureEnd` and for the host's Escape/right-click affordances a
 * future pass could add — mirrors `vector.pen`'s own `finishPath` export
 * shape, even though this tool has no menu wired to it yet. */
export async function commitShapeBuilderDrag(context: ToolContext<ShapeBuilderState>): Promise<void> {
  const { faces, drag, styleById, orderedSourceIds } = context.state;
  if (!faces || !drag) return;
  context.setState({ ...context.state, drag: null, hovered: null });
  if (drag.touched.size === 0) return;

  const port = getSharedGeometryPort();
  const keptIndices = faces.map((_, index) => index).filter((index) => !drag.touched.has(index));
  const results: VectorShape[] = [];

  for (const index of keptIndices) {
    const face = faces[index]!;
    const style = styleById.get(face.sourceIds[0]!);
    if (style) results.push(pathShapeFromPolygon(face.polygon, "Shape Builder Result (Результат построения фигур)", style));
  }

  if (!drag.erasing) {
    const touchedIndices = [...drag.touched];
    const merged = await unionFaces(port, faces, touchedIndices);
    // The topmost owner among every touched face's own topmost owner —
    // `orderedSourceIds` is topmost-first, so the first id it names that
    // any touched face actually claims is the answer.
    const touchedOwners = new Set(touchedIndices.flatMap((index) => faces[index]!.sourceIds));
    const styleOwner = orderedSourceIds.find((id) => touchedOwners.has(id));
    const style = styleOwner ? styleById.get(styleOwner) : undefined;
    if (style) for (const piece of merged) results.push(pathShapeFromPolygon(piece, "Shape Builder Result (Результат построения фигур)", style));
  }

  await context.changeDocument("Shape Builder (Построение фигур)", (draft) => {
    removeShapes(draft, orderedSourceIds);
    for (const result of results) addShape(draft, result);
    draft.selection = results.map((result) => result.id);
    draft.activeShapeId = results[0]?.id ?? null;
    return true;
  });
}

const shapeBuilder: VectorToolDefinition<ShapeBuilderState> = {
  id: "vector.shape-builder",
  createState: () => empty,

  onPointerDown(context, pointer: ToolPointer) {
    const { faces } = context.state;
    if (!faces) return;
    const hit = faceAt(faces, pointer.point.x, pointer.point.y);
    if (hit === null) return;
    context.setState({ ...context.state, hovered: hit, drag: { touched: new Set([hit]), erasing: pointer.altKey } });
  },

  onPointerMove(context, pointer: ToolPointer) {
    const { faces, drag } = context.state;
    if (!faces) return;
    const hit = faceAt(faces, pointer.point.x, pointer.point.y);
    if (!drag) {
      if (hit !== context.state.hovered) context.setState({ ...context.state, hovered: hit });
      return;
    }
    if (hit === null || drag.touched.has(hit)) return;
    context.setState({ ...context.state, hovered: hit, drag: { ...drag, touched: new Set([...drag.touched, hit]) } });
  },

  onGestureEnd(context) {
    void commitShapeBuilderDrag(context);
  },

  onDeactivate(context) {
    // Thrown away, not committed — same reasoning `vector.select` gives for
    // "what's hovered" never being state worth preserving across a tool
    // switch, and additionally because the fracture itself would otherwise
    // silently go stale the moment the document or selection changes.
    context.setState(empty);
  },

  Overlay({ state, context, document }) {
    // The fracture itself: computed once, the first time this Overlay
    // mounts with a real selection and no faces yet. `document.revision`
    // and the selection are the only two things that should ever trigger a
    // fresh fracture — both are read directly rather than trusted to a
    // dependency array that could silently miss one of them.
    useEffect(() => {
      if (state.faces !== null) return;
      const selected = document.shapes.filter((shape) => document.selection.includes(shape.id));
      if (selected.length < 2) { context.setState({ ...state, faces: [] }); return; }
      // Topmost-first, matching `applyPathfinderOp`'s own selection order
      // and `buildShapeBuilderFaces`'s own documented expectation.
      const ordered = [...selected].reverse();
      const polygons = ordered.map((shape) => ({ id: shape.id, polygon: shapeOutlineWorldPolygon(shape, document.shapes) })).filter((entry): entry is { id: string; polygon: Float64Array } => entry.polygon !== null);
      if (polygons.length < 2) { context.setState({ ...state, faces: [] }); return; }
      const styleById = new Map(ordered.map((shape) => [shape.id, shape.style]));
      let cancelled = false;
      void buildShapeBuilderFaces(getSharedGeometryPort(), polygons).then((faces) => {
        if (!cancelled) context.setState({ ...state, faces, styleById, orderedSourceIds: polygons.map((entry) => entry.id) });
      });
      return () => { cancelled = true; };
      // `document.shapes`/`document.selection` themselves, not a revision
      // counter (`VectorDocumentState` — the `Overlay` prop's own type —
      // carries no such field; that lives one level up, on the
      // `VravioDocument` wrapper `VectorWorkspace.tsx` reads for its own
      // `useMemo`s). Both are replaced wholesale on every store update in
      // this codebase's own update convention, so a reference check here
      // is exactly as reliable a "did anything relevant change" signal.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.faces === null, document.shapes, document.selection]);

    if (!state.faces?.length) return null;
    return <>
      {state.faces.map((face, index) => {
        const path = `M ${Array.from({ length: face.polygon.length / 2 }, (_, i) => `${face.polygon[i * 2]} ${face.polygon[i * 2 + 1]}`).join(" L ")} Z`;
        const active = state.drag ? state.drag.touched.has(index) : index === state.hovered;
        return <path key={index} className={active ? "vector-shape-builder-face active" : "vector-shape-builder-face"} d={path} strokeWidth={1 / context.viewport.zoom}/>;
      })}
    </>;
  },
};

export default shapeBuilder;
