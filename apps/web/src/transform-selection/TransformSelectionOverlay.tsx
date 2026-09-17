import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { frameBounds, frameCorners, mapFramePoint, traceSelectionOutlines, transformSelectionMask, type Point, type RasterDocumentState, type SelectionFrame } from "@vravio/env-raster";
import { changeRasterSelection } from "../commands";
import { publishEditSession, touchEditSessions } from "../contextual-bar/sessions";
import { MarchingAnts } from "../marching-ants";
import { rotateCursorFor, scaleCursorFor } from "../transform-cursors";
import { endTransformSelection, transformSelectionFrame, updateTransformSelection, useTransformSelection } from "./session";

/**
 * Select ▸ Transform Selection, on the canvas.
 *
 * Photoshop's behaviour is the donor: a bounding box with eight handles around
 * the selection; drag inside to move, a handle to scale (Shift keeps the
 * proportions), just outside a corner to rotate (Shift snaps to 15°); Enter
 * applies, Escape cancels; and only the outline changes — the layer's pixels
 * never move. The engine side is `transformSelectionMask` (one bilinear
 * resample, on apply).
 *
 * Lives inside the zoomable `.raster-stage`, in document coordinates, so it
 * follows pan, zoom and view rotation for free — and therefore every size a
 * user sees is divided by the zoom (CLAUDE.md §1): handles, rotate zones and
 * line widths are screen pixels, never document pixels. Pointer positions are
 * read back through the SVG's own screen matrix, which already includes the
 * stage's CSS transform.
 *
 * Its Done / Cancel / Rotate 90° are also published to the Contextual Task Bar
 * (`contextual-bar/sessions.ts`) — the same functions Enter and Escape call.
 */

const HANDLE = 8, ROTATE_ZONE = 22;

type Drag =
  | { kind: "move"; pointerId: number; start: Point; frame: SelectionFrame }
  | { kind: "scale"; pointerId: number; start: Point; frame: SelectionFrame; hx: -1 | 0 | 1; hy: -1 | 0 | 1 }
  | { kind: "rotate"; pointerId: number; startAngle: number; frame: SelectionFrame };

const HANDLES: readonly (readonly [-1 | 0 | 1, -1 | 0 | 1])[] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

/** Rotates a vector by -degrees: screen/document deltas into the frame's own unrotated axes. */
const unrotate = (dx: number, dy: number, degrees: number): Point => {
  const r = -degrees * Math.PI / 180;
  return { x: dx * Math.cos(r) - dy * Math.sin(r), y: dx * Math.sin(r) + dy * Math.cos(r) };
};

export function applyTransformSelection(documentId: string): void {
  const frame = transformSelectionFrame(documentId);
  endTransformSelection(documentId);
  if (!frame) return;
  const unchanged = frame.rotation === 0 && frame.target.x === frame.source.x && frame.target.y === frame.source.y && frame.target.width === frame.source.width && frame.target.height === frame.source.height;
  if (unchanged) return;
  void changeRasterSelection(documentId, "Transform Selection (Трансформировать выделение)", (state) => transformSelectionMask(state.selection, state.width, state.height, frame));
}

export function TransformSelectionOverlay({ documentId, state, zoom }: { documentId: string; state: RasterDocumentState; zoom: number }) {
  const frame = useTransformSelection(documentId);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const selection = state.selection;

  // Outline loops of the selection as it was when the session opened; each
  // point is mapped through the frame on render, so line widths stay in screen
  // pixels instead of being scaled with a group transform.
  const loops = useMemo(() => (frame && selection ? traceSelectionOutlines(selection.mask, state.width, state.height, 127, selection.bounds) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Boolean(frame), selection, state.width, state.height]);

  // A selection replaced or dropped from elsewhere (undo, Deselect) ends the session.
  const openedWith = useRef(selection);
  useEffect(() => {
    if (!frame) { openedWith.current = selection; return; }
    if (selection !== openedWith.current) endTransformSelection(documentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, Boolean(frame)]);

  const active = Boolean(frame && selection);
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); applyTransformSelection(documentId); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); endTransformSelection(documentId); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    const withdraw = publishEditSession(documentId, {
      kind: "transform",
      commit: () => applyTransformSelection(documentId),
      cancel: () => endTransformSelection(documentId),
      rotate: (degrees) => {
        const current = transformSelectionFrame(documentId);
        if (current) updateTransformSelection(documentId, { ...current, rotation: ((current.rotation + degrees) % 360 + 540) % 360 - 180 });
        touchEditSessions();
      },
      frame: () => { const current = transformSelectionFrame(documentId); return current ? frameBounds(current) : null; },
    });
    return () => { window.removeEventListener("keydown", onKeyDown, true); withdraw(); };
  }, [active, documentId]);

  if (!frame || !selection) return null;

  const toDocument = (event: ReactPointerEvent): Point => {
    const svg = svgRef.current, matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const mapped = point.matrixTransform(matrix.inverse());
    return { x: mapped.x, y: mapped.y };
  };
  const centre = (current: SelectionFrame): Point => ({ x: current.target.x + current.target.width / 2, y: current.target.y + current.target.height / 2 });

  const begin = (event: ReactPointerEvent, make: (point: Point) => Drag) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    dragRef.current = make(toDocument(event));
  };

  const move = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = toDocument(event);
    const base = drag.frame;
    if (drag.kind === "move") {
      const dx = point.x - drag.start.x, dy = point.y - drag.start.y;
      updateTransformSelection(documentId, { ...base, target: { ...base.target, x: base.target.x + dx, y: base.target.y + dy } });
      return;
    }
    if (drag.kind === "rotate") {
      const c = centre(base);
      const raw = base.rotation + (Math.atan2(point.y - c.y, point.x - c.x) - drag.startAngle) * 180 / Math.PI;
      const rotation = event.shiftKey ? Math.round(raw / 15) * 15 : raw;
      updateTransformSelection(documentId, { ...base, rotation });
      return;
    }
    // Scale: work in the frame's own axes, so a rotated box still scales along its sides; the
    // opposite handle stays put.
    const local = unrotate(point.x - drag.start.x, point.y - drag.start.y, base.rotation);
    const t = base.target;
    let width = t.width + drag.hx * local.x, height = t.height + drag.hy * local.y;
    if (event.shiftKey && drag.hx !== 0 && drag.hy !== 0) {
      const scale = Math.max(width / t.width, height / t.height);
      width = t.width * scale; height = t.height * scale;
    }
    width = drag.hx === 0 ? t.width : Math.max(1, width);
    height = drag.hy === 0 ? t.height : Math.max(1, height);
    // The opposite handle stays where it is on screen: find it in document space before the
    // resize, then put the new box's centre back relative to it along the frame's own axes.
    const radians = base.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const toWorld = (lx: number, ly: number, c: Point): Point => ({ x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos });
    const anchor = toWorld(-drag.hx * t.width / 2, -drag.hy * t.height / 2, centre(base));
    const offset = toWorld(-drag.hx * width / 2, -drag.hy * height / 2, { x: 0, y: 0 });
    const newCentre = { x: anchor.x - offset.x, y: anchor.y - offset.y };
    const next = { x: newCentre.x - width / 2, y: newCentre.y - height / 2, width, height };
    updateTransformSelection(documentId, { ...base, target: next });
  };

  const end = (event: ReactPointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const corners = frameCorners(frame);
  const path = loops.map((loop) => `M${loop.points.map((p) => { const q = mapFramePoint(frame, p); return `${q.x} ${q.y}`; }).join("L")}Z`).join("");
  const handlePoint = (hx: number, hy: number): Point => mapFramePoint(frame, { x: frame.source.x + (hx + 1) / 2 * frame.source.width, y: frame.source.y + (hy + 1) / 2 * frame.source.height });
  const size = HANDLE / zoom, zone = ROTATE_ZONE / zoom;

  return <svg ref={svgRef} className="transform-controls transform-selection-controls" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
    {path && <MarchingAnts zoom={zoom}><path d={path} /></MarchingAnts>}
    {/* Rotate zones: a disc just outside each corner, under the handles. */}
    {corners.map((corner, index) => <circle key={`rotate-${index}`} className="transform-selection-rotate" cx={corner.x} cy={corner.y} r={zone} style={{ cursor: rotateCursorFor(index === 0 || index === 3 ? -1 : 1, index < 2 ? -1 : 1) }}
      onPointerDown={(event) => begin(event, (point) => { const c = centre(frame); return { kind: "rotate", pointerId: event.pointerId, startAngle: Math.atan2(point.y - c.y, point.x - c.x), frame }; })} />)}
    <polygon className="transform-selection-body" points={corners.map((corner) => `${corner.x},${corner.y}`).join(" ")} strokeWidth={1 / zoom}
      onPointerDown={(event) => begin(event, (point) => ({ kind: "move", pointerId: event.pointerId, start: point, frame }))} />
    {HANDLES.map(([hx, hy]) => { const p = handlePoint(hx, hy); return <rect key={`${hx},${hy}`} className="transform-handle transform-selection-handle" data-handle={`${hx},${hy}`} x={p.x - size / 2} y={p.y - size / 2} width={size} height={size} strokeWidth={1 / zoom}
      transform={`rotate(${frame.rotation} ${p.x} ${p.y})`} style={{ cursor: scaleCursorFor(hx, hy) }}
      onPointerDown={(event) => begin(event, (point) => ({ kind: "scale", pointerId: event.pointerId, start: point, frame, hx, hy }))} />; })}
  </svg>;
}
