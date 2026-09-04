import { useEffect } from "react";
import type { VectorDocumentState, VectorPoint, VectorShape } from "@vravio/env-vector";
import type { VectorSnapshot } from "../../../../vector-commands";
import { beginSelectDrag, type SelectState } from "./select";
import type { ToolContext, ToolPointer, VectorToolDefinition } from "../types";

/**
 * Edits a path's anchors and Bézier handles — the pre-port code's
 * `activeToolId === "vector.nodes"` branch of `onPointerDown`, plus the node
 * overlay it drew unconditionally alongside the selection handles.
 *
 * When the click misses every node, this falls through to the exact same
 * "pick a shape or deselect" tail `vector.select` uses (`beginSelectDrag`,
 * shared rather than duplicated) — the pre-port code's own comment called
 * this out explicitly ("Fall through to the select-tool behavior below").
 */

type NodePart = "anchor" | "handleIn" | "handleOut";

function nodePosition(point: VectorPoint, part: NodePart): { x: number; y: number } {
  if (part === "anchor") return { x: point.x, y: point.y };
  const handle = point[part];
  return handle ? { x: point.x + handle.x, y: point.y + handle.y } : { x: point.x, y: point.y };
}

/** Closest anchor/handle of a path within `tolerance` document units of `at`,
 * preferring handles (they sit on top visually) over anchors when both are in
 * range — read verbatim off the pre-port `hitTestNode`. */
function hitTestNode(shape: VectorShape, at: { x: number; y: number }, tolerance: number): { pointIndex: number; part: NodePart } | null {
  if (shape.kind !== "path") return null;
  type Best = { pointIndex: number; part: NodePart; distance: number };
  let best: Best | null = null;
  shape.points.forEach((point, pointIndex) => {
    (["handleOut", "handleIn", "anchor"] as const).forEach((part) => {
      if (part !== "anchor" && !point[part]) return;
      const position = nodePosition(point, part);
      const distance = Math.hypot(position.x - at.x, position.y - at.y);
      if (distance <= tolerance && (!best || distance < (best as Best).distance)) best = { pointIndex, part, distance };
    });
  });
  return best ? { pointIndex: (best as Best).pointIndex, part: (best as Best).part } : null;
}

interface NodeDrag { readonly shapeId: string; readonly pointIndex: number; readonly part: NodePart; readonly before: VectorSnapshot }

export interface NodesState {
  readonly selectedNode: { readonly shapeId: string; readonly pointIndex: number } | null;
  readonly nodeDrag: NodeDrag | null;
  readonly shapeDrag: SelectState["drag"];
}

const empty: NodesState = { selectedNode: null, nodeDrag: null, shapeDrag: null };

const nodes: VectorToolDefinition<NodesState> = {
  id: "vector.nodes",
  createState: () => empty,

  onPointerDown(context, pointer) {
    const tolerance = 6 / context.viewport.zoom;
    const node = context.activeShape ? hitTestNode(context.activeShape, pointer.point, tolerance) : null;
    if (node && context.activeShape) {
      context.setState({ selectedNode: { shapeId: context.activeShape.id, pointIndex: node.pointIndex }, nodeDrag: { shapeId: context.activeShape.id, pointIndex: node.pointIndex, part: node.part, before: context.snapshot() }, shapeDrag: null });
      return;
    }
    // Same tail as vector.select: pick the shape under the pointer, or
    // deselect. beginSelectDrag only touches its own `drag` field, so it is
    // safe to call against a context typed for SelectState and read the
    // result back into this tool's own (differently shaped) state.
    const selectContext = context as unknown as ToolContext<SelectState>;
    beginSelectDrag(selectContext, pointer);
    context.setState({ selectedNode: null, nodeDrag: null, shapeDrag: (selectContext.state as unknown as SelectState).drag });
  },

  onPointerMove(context, pointer) {
    const { nodeDrag, shapeDrag } = context.state;
    if (nodeDrag) {
      const { shapeId, pointIndex, part } = nodeDrag;
      context.mutate((draft) => {
        const shape = draft.shapes.find((item) => item.id === shapeId);
        if (shape?.kind !== "path" || !shape.points[pointIndex]) return;
        shape.points = shape.points.map((current, index) => {
          if (index !== pointIndex) return current;
          if (part === "anchor") return { ...current, x: pointer.point.x, y: pointer.point.y };
          const offset = { x: pointer.point.x - current.x, y: pointer.point.y - current.y };
          const mirror = !pointer.altKey;
          const opposite: NodePart = part === "handleOut" ? "handleIn" : "handleOut";
          return { ...current, [part]: offset, ...(mirror ? { [opposite]: { x: -offset.x, y: -offset.y } } : {}) };
        });
      });
      return;
    }
    if (shapeDrag) {
      const dx = pointer.point.x - shapeDrag.start.x, dy = pointer.point.y - shapeDrag.start.y;
      context.setState({ ...context.state, shapeDrag: { ...shapeDrag, start: pointer.point } });
      context.mutate((draft: VectorDocumentState) => {
        const shape = draft.shapes.find((item) => item.id === shapeDrag.shapeId);
        if (!shape) return;
        if (shape.kind === "rectangle" || shape.kind === "ellipse" || shape.kind === "text" || shape.kind === "image") { shape.x += dx; shape.y += dy; }
        else if (shape.kind === "line") { shape.x1 += dx; shape.y1 += dy; shape.x2 += dx; shape.y2 += dy; }
        else if (shape.kind === "path") shape.points = shape.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
      });
    }
  },

  onGestureEnd(context) {
    const { nodeDrag, shapeDrag, selectedNode } = context.state;
    context.setState({ selectedNode, nodeDrag: null, shapeDrag: null });
    if (nodeDrag) context.commitDrag(nodeDrag.before, "Edit Path (Изменить контур)");
    else if (shapeDrag) context.commitDrag(shapeDrag.before, "Move Shape (Переместить фигуру)");
  },

  onDeactivate(context) {
    context.setState(empty);
  },

  Overlay({ state, document, options, context }) {
    // Delete/Backspace removes the selected anchor — the pre-port code's own
    // global keydown handler gated this on `activeToolId === "vector.nodes"`;
    // now that the tool owns its Overlay, it owns the shortcut too, the same
    // move raster.move made for its Enter/Escape handling. `context` is
    // included in the dependency array deliberately: the host builds a fresh
    // context every render, and a callback that closed over a stale one from
    // an earlier render is exactly the class of bug CLAUDE.md's ToolContext
    // snapshot lesson (raster.move's scale/rotate handles) warns about.
    useEffect(() => {
      const selected = state.selectedNode;
      if (!selected) return;
      const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        event.preventDefault();
        // The path shape itself is still the active selection while editing
        // its nodes — without this, the host's own generic "Delete/Backspace
        // removes the selected shape" handler (VectorWorkspace.tsx, bubble
        // phase on the same `window`) would fire right after this capture-
        // phase listener and delete the whole path out from under the point
        // that was just removed from it.
        event.stopPropagation();
        const { shapeId, pointIndex } = selected;
        context.setState({ ...context.state, selectedNode: null });
        void context.changeDocument("Delete Point (Удалить точку)", (draft) => {
          const shape = draft.shapes.find((item) => item.id === shapeId);
          if (shape?.kind !== "path" || shape.points.length <= 2) return false;
          shape.points = shape.points.filter((_, index) => index !== pointIndex);
          return true;
        });
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [state.selectedNode, context]);

    const active = document.shapes.find((shape) => shape.id === document.activeShapeId) ?? null;
    if (active?.kind !== "path") return null;
    const zoom = context.viewport.zoom;
    // "Bézier handles" was declared on this tool's own option schema but the
    // pre-port code drew the handle lines/dots unconditionally — the
    // dead-checkbox CLAUDE.md §3 rules out. The anchor squares themselves
    // stay unconditional: the option is specifically "handles", not "the
    // node overlay" as a whole, and an anchor with no visible handle is
    // still where a click has to land to grab or delete it.
    const showHandles = options.showHandles !== false;
    return <>
      {active.points.map((point, pointIndex) => {
        const isSelected = state.selectedNode?.shapeId === active.id && state.selectedNode.pointIndex === pointIndex;
        return <g key={pointIndex}>
          {showHandles && point.handleOut && <line className="vector-node-handle-line" x1={point.x} y1={point.y} x2={point.x + point.handleOut.x} y2={point.y + point.handleOut.y} vectorEffect="non-scaling-stroke"/>}
          {showHandles && point.handleIn && <line className="vector-node-handle-line" x1={point.x} y1={point.y} x2={point.x + point.handleIn.x} y2={point.y + point.handleIn.y} vectorEffect="non-scaling-stroke"/>}
          {showHandles && point.handleOut && <circle className="vector-node-handle" cx={point.x + point.handleOut.x} cy={point.y + point.handleOut.y} r={3.5 / zoom} vectorEffect="non-scaling-stroke"/>}
          {showHandles && point.handleIn && <circle className="vector-node-handle" cx={point.x + point.handleIn.x} cy={point.y + point.handleIn.y} r={3.5 / zoom} vectorEffect="non-scaling-stroke"/>}
          <rect className={isSelected ? "vector-node-anchor selected" : "vector-node-anchor"} x={point.x - 4 / zoom} y={point.y - 4 / zoom} width={8 / zoom} height={8 / zoom} vectorEffect="non-scaling-stroke"/>
        </g>;
      })}
    </>;
  },
};

export default nodes;
