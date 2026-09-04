import { useEffect, useRef } from "react";
import {
  cloneRasterState, layerAccepts, layerLockReason, layerOpaqueBounds, liftSelection, meshLayerPixels, meshSelection,
  pickLayerAt, quadLayerPixels, quadSelection, regularMesh, restrictSelectionToAlpha, rotateLayerPixels, rotateSelection,
  scaleLayerPixels, scaleSelection, setLayerPixels, stampFloating, translateLayerPixels, translateSelection, unionRect, WARP_GRID,
  type FloatingPixels, type PixelSelection, type Point, type RasterDocumentState, type RasterRect, type RasterTextData,
} from "@vravio/env-raster";
import { diagnostic } from "../../../../diagnostics";
import { identityTextTransform, multiplyTextTransform, renderTextLayerPixels, textBoundsTransform } from "../../../../textRender";
import type { RasterToolDefinition, ToolContext, ToolPointer } from "../types";

/**
 * The Move tool — auto-select, floating selections, four transform sub-modes
 * (scale/rotate/skew-distort-perspective/warp) and text-layer transforms,
 * all sharing one "pending" transform that survives across several separate
 * drags until Enter or a click outside its frame commits it.
 *
 * The last tool on the old `switch`, and deliberately its own session in
 * docs/migration-plan.md: every other tool in stage 5 had at least one
 * simplifying trait (a single branch, an isolated gesture, a clean split
 * between "drag" and "commit"). Move has none of them — a drag can *start*
 * a pending transform, *continue* one already open, or *grab a handle* on
 * one, and none of those three commits anything by itself. Read
 * `docs/migration-plan.md`'s "`raster.crop` — отделён от `move`" subsection
 * before changing this file; it records why crop went first and what was
 * deliberately left for here.
 */

export interface PendingTextTransform { readonly original: RasterTextData; readonly initialBounds: RasterRect; readonly targetBounds: RasterRect }

export interface PendingTransform {
  readonly before: RasterDocumentState;
  readonly layerId: string;
  readonly dx: number;
  readonly dy: number;
  readonly pixels: Uint8ClampedArray;
  readonly selection: PixelSelection | null;
  readonly rotation: number;
  readonly text?: PendingTextTransform;
  /** Content lifted off the layer once; every drag places the same float rather than cutting a
   * second hole out of an image already cut from — see CLAUDE.md's floating-selection lesson. */
  readonly float?: FloatingPixels;
  /** Present once Skew/Distort/Perspective has been entered via the right-click menu. Additive,
   * not a replacement for ordinary move/scale/rotate — there is no path back out of it within
   * the same pending transform once entered (matches the pre-port behaviour byte for byte). */
  readonly corners?: readonly [Point, Point, Point, Point];
  /** Present once Warp has been entered: the current 4x4 anchor grid. `meshOrigin` is the fixed
   * pristine pixels+bounds every resample reads from, regardless of how many separate point-drags
   * this Warp session sees — never a previous drag's already-warped result. */
  readonly mesh?: readonly Point[];
  readonly meshOrigin?: { readonly pixels: Uint8ClampedArray; readonly bounds: RasterRect };
}

type QuadTransformMode = "skew" | "distort" | "perspective";

type MoveDrag =
  | { kind: "move"; pointerId: number; from: Point; current: Point; before: RasterDocumentState; startDx: number; startDy: number; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; rotation: number; text?: PendingTextTransform; createdTextTransform?: boolean; fromOrigin?: boolean; float?: FloatingPixels }
  | { kind: "scale"; pointerId: number; from: Point; current: Point; before: RasterDocumentState; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; sourceBounds: RasterRect; handleX: -1 | 0 | 1; handleY: -1 | 0 | 1; dx: number; dy: number; text?: PendingTextTransform }
  | { kind: "rotate"; pointerId: number; from: Point; current: Point; before: RasterDocumentState; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; sourceBounds: RasterRect; center: Point; startAngle: number; baseRotation: number; dx: number; dy: number; text?: PendingTextTransform }
  | { kind: "quad"; pointerId: number; from: Point; current: Point; before: RasterDocumentState; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; sourceBounds: RasterRect; baseCorners: readonly [Point, Point, Point, Point]; handleIndex: number; mode: QuadTransformMode }
  | { kind: "warp"; pointerId: number; from: Point; current: Point; before: RasterDocumentState; meshOrigin: { pixels: Uint8ClampedArray; bounds: RasterRect }; baseSelection: PixelSelection | null; baseMesh: readonly Point[]; pointIndex: number };

export interface MoveState {
  readonly pending: PendingTransform | null;
  readonly drag: MoveDrag | null;
}

export const empty: MoveState = { pending: null, drag: null };

const cloneSelection = (selection: PixelSelection | null): PixelSelection | null => selection ? { mask: selection.mask.slice(), bounds: { ...selection.bounds } } : null;

/** Copies one rectangle out of a document-sized buffer — the live text-preview canvas's source. */
function cropPixels(pixels: Uint8ClampedArray, width: number, region: RasterRect): Uint8ClampedArray {
  const output = new Uint8ClampedArray(region.width * region.height * 4);
  for (let row = 0; row < region.height; row += 1) {
    const start = ((region.y + row) * width + region.x) * 4;
    output.set(pixels.subarray(start, start + region.width * 4), row * region.width * 4);
  }
  return output;
}

/** Which corner (0-3, TL/TR/BR/BL) or, for Skew, which edge-midpoint (4-7, top/right/bottom/left) a quad handle index refers to. */
export function quadHandlePoints(corners: readonly [Point, Point, Point, Point], mode: QuadTransformMode): { index: number; point: Point }[] {
  const [tl, tr, br, bl] = corners;
  if (mode !== "skew") return [{ index: 0, point: tl }, { index: 1, point: tr }, { index: 2, point: br }, { index: 3, point: bl }];
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return [{ index: 4, point: mid(tl, tr) }, { index: 5, point: mid(tr, br) }, { index: 6, point: mid(br, bl) }, { index: 7, point: mid(bl, tl) }];
}

/**
 * Applies one handle's cumulative drag (from the gesture's start) to a copy of the corners it
 * started with — recomputed fresh from that base every frame, so a fast pointer can't compound
 * rounding error frame over frame.
 *
 * Skew's two edge handles slide their whole edge as a unit, so every corner stays on a straight
 * line — a parallelogram, never a general quad. Distort moves exactly the one corner grabbed.
 * Perspective moves that corner AND mirrors its edge-partners the opposite way, which is what
 * keeps a single drag reading as "this edge narrows toward a vanishing point" instead of
 * lopsided — a light approximation of a true one-point perspective grid, not a projective solve.
 */
function applyQuadHandleDelta(base: readonly [Point, Point, Point, Point], handleIndex: number, mode: QuadTransformMode, dx: number, dy: number): [Point, Point, Point, Point] {
  const corners: [Point, Point, Point, Point] = [{ ...base[0] }, { ...base[1] }, { ...base[2] }, { ...base[3] }];
  if (mode === "skew") {
    if (handleIndex === 4) { corners[0].x += dx; corners[1].x += dx; }
    else if (handleIndex === 5) { corners[1].y += dy; corners[2].y += dy; }
    else if (handleIndex === 6) { corners[2].x += dx; corners[3].x += dx; }
    else if (handleIndex === 7) { corners[0].y += dy; corners[3].y += dy; }
    return corners;
  }
  corners[handleIndex] = { x: base[handleIndex]!.x + dx, y: base[handleIndex]!.y + dy };
  if (mode === "perspective") {
    const hPartner = [1, 0, 3, 2][handleIndex]!, vPartner = [3, 2, 1, 0][handleIndex]!;
    corners[hPartner]!.x = base[hPartner]!.x - dx;
    corners[vPartner]!.y = base[vPartner]!.y - dy;
  }
  return corners;
}

/** The frame a pending transform's handles sit on — text uses its own live-typed bounds, a
 * pixel transform falls back to the selection or the transformed content's own opaque extent. */
export function pendingBounds(pending: PendingTransform, width: number, height: number): RasterRect | null {
  return pending.text?.targetBounds ?? pending.selection?.bounds ?? layerOpaqueBounds(pending.pixels, width, height);
}

/**
 * Enters Skew/Distort/Perspective on an existing pending transform — exported for the
 * workspace's own right-click menu, which stays host-level chrome the same way the marquee
 * tools' Replace/Add/Subtract/Intersect menu did after those were ported (see CONTRIBUTING.md).
 * Keeping the construction here rather than at the host avoids a second, drifting copy of what a
 * quad-mode `PendingTransform` looks like. A no-op once corners already exist — matches the
 * pre-port rule that there is no path back out of quad mode within the same pending transform.
 */
export function enterQuadTransformMode(pending: PendingTransform, bounds: RasterRect): PendingTransform {
  if (pending.corners) return pending;
  const corners: readonly [Point, Point, Point, Point] = [{ x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height }];
  return { ...pending, corners };
}

/** Enters Warp — the mesh counterpart of {@link enterQuadTransformMode}, same reasoning. */
export function enterWarpTransformMode(pending: PendingTransform, bounds: RasterRect): PendingTransform {
  if (pending.mesh) return pending;
  return { ...pending, mesh: regularMesh(bounds, WARP_GRID), meshOrigin: { pixels: pending.pixels.slice(), bounds: { ...bounds } } };
}

export type { QuadTransformMode };

/** Opens a pending transform on the active layer without any pointer gesture — what the Edit ▸
 * Free Transform (Ctrl+T) menu item needs, since it has no drag of its own to start one from.
 * A no-op if one is already open (matches the old menu command's own guard). */
export function startPendingTransform(context: ToolContext<MoveState>): void {
  if (context.state.pending) return;
  const state = context.document;
  const layer = context.activeLayer;
  if (!layer) return;
  const liveText = layer.kind === "text" && Boolean(layer.text) && !state.selection;
  const before = liveText ? state : cloneRasterState(state);
  const target = liveText ? layer : (before.layers.find((item) => item.id === layer.id) ?? layer);
  const selection = before.selection ? restrictSelectionToAlpha(before.selection, materialise(target, before), state.width, state.height) : null;
  if (before.selection && !selection) { diagnostic("info", "transform", "Transform ignored: selection contains no opaque pixels", { layerId: target.id }); return; }
  const pixels = materialise(target, before);
  const opaque = layerOpaqueBounds(pixels, state.width, state.height);
  const textBounds = target.kind === "text" && target.text?.visualBounds?.width ? target.text.visualBounds : null;
  if (!selection && !textBounds && !opaque) { diagnostic("info", "transform", "Transform ignored: layer is empty", { layerId: target.id }); return; }
  const bounds = textBounds ?? opaque!;
  const pending: PendingTransform = {
    before, layerId: target.id, dx: 0, dy: 0, pixels: pixels.slice(), selection, rotation: 0,
    ...(liveText ? { text: { original: structuredClone(target.text!), initialBounds: { ...bounds }, targetBounds: { ...bounds } } } : {}),
  };
  context.setState({ pending, drag: null });
}

/** Bakes a pending transform into the document — the only place `context.commitDocument` is
 * called from, whether triggered by Enter, a click outside the frame, or the tool deactivating. */
export function commitPending(context: ToolContext<MoveState>, pending: PendingTransform, nextActiveLayerId?: string): void {
  if (pending.text) {
    const beforeAfter = context.document.layers.find((item) => item.id === pending.layerId);
    if (!beforeAfter) return;
    const beforeDoc = pending.before;
    const beforeText = structuredClone(pending.text.original);
    const delta = textBoundsTransform(pending.text.initialBounds, pending.text.targetBounds, pending.rotation);
    const afterText: RasterTextData = { ...beforeText, transform: multiplyTextTransform(delta, beforeText.transform ?? identityTextTransform()) };
    const afterDoc = cloneRasterState(beforeDoc);
    const target = afterDoc.layers.find((item) => item.id === pending.layerId);
    // setLayerPixels, not a direct assignment: it trims the full-canvas buffer
    // renderTextLayerPixels returns down to the layer's own opaque bounds and
    // updates `target.bounds` to match — the invariant the compositor's
    // non-wholeCanvas path relies on (render.ts reads `layer.pixels` as if it
    // were already sized to `layer.bounds`). Assigning the untrimmed buffer
    // straight to `target.pixels` leaves `target.bounds` at its pre-transform
    // (smaller) rectangle while `pixels` is document-sized, so the compositor
    // indexes into it with the wrong stride and the layer renders as empty.
    if (target) { target.text = structuredClone(afterText); setLayerPixels(target, renderTextLayerPixels(target.text, afterDoc.width, afterDoc.height), afterDoc.width, afterDoc.height); }
    void context.commitDocument(beforeDoc, afterDoc, "Transform Type Layer (Трансформация текстового слоя)");
    return;
  }
  const after = cloneRasterState(pending.before);
  const layer = after.layers.find((item) => item.id === pending.layerId);
  let bounds: RasterRect | null = null;
  if (layer) {
    const sourceLayer = pending.before.layers.find((item) => item.id === pending.layerId);
    const wasThere = sourceLayer ? layerOpaqueBounds(materialise(sourceLayer, pending.before), pending.before.width, pending.before.height) : null;
    const isThere = layerOpaqueBounds(pending.pixels, pending.before.width, pending.before.height);
    bounds = wasThere && isThere ? unionRect(wasThere, isThere.x, isThere.y, isThere.x + isThere.width, isThere.y + isThere.height, 1) : wasThere ?? isThere;
    setLayerPixels(layer, pending.pixels, pending.before.width, pending.before.height);
  }
  after.selection = cloneSelection(pending.selection);
  if (nextActiveLayerId) after.activeLayerId = nextActiveLayerId;
  void context.commitDocument(pending.before, after, "Commit Transform (Применить трансформацию)", bounds);
}

/** A layer's pixels laid out at document size — every ToolContext hands this out already
 * materialised for the *active* layer (`layerPixels()`), but a pending transform may be tracking
 * a *different* layer's `before` snapshot (auto-select mid-transform, or committing after the
 * active layer has since changed), so this reads any layer directly off a given document. */
function materialise(layer: RasterDocumentState["layers"][number], document: RasterDocumentState): Uint8ClampedArray {
  const out = new Uint8ClampedArray(document.width * document.height * 4);
  for (let y = 0; y < layer.bounds.height; y += 1) {
    const from = y * layer.bounds.width * 4;
    out.set(layer.pixels.subarray(from, from + layer.bounds.width * 4), ((layer.bounds.y + y) * document.width + layer.bounds.x) * 4);
  }
  return out;
}

/** Starts (or continues) an ordinary translate drag — the shared tail both "no pending transform
 * yet" and "clicked inside an existing one's frame, not on a handle" fall into, exactly as the
 * pre-port `handlePointerDown` did with one shared `if (activeToolId === "raster.move")` block. */
function beginMoveDrag(context: ToolContext<MoveState>, pointer: ToolPointer, pending: PendingTransform | null, layer: NonNullable<ToolContext<MoveState>["activeLayer"]>): void {
  const state = context.document;
  const effectiveSelection = !pending ? restrictSelectionToAlpha(state.selection, materialise(layer, state), state.width, state.height) : null;
  if (!pending) {
    if (state.selection && !effectiveSelection) { diagnostic("info", "move", "Move ignored: selection contains no opaque pixels", { layerId: layer.id }); return; }
    if (!state.selection && !(layer.kind === "text" && layer.text?.visualBounds?.width ? layer.text.visualBounds : layerOpaqueBounds(materialise(layer, state), state.width, state.height))) {
      diagnostic("info", "move", "Move ignored: layer is empty", { layerId: layer.id }); return;
    }
  }
  context.capturePointer(pointer.pointerId);
  let next = pending, createdTextTransform = false;
  if (!next && layer.kind === "text" && layer.text && !effectiveSelection) {
    const bounds = layer.text.visualBounds?.width ? layer.text.visualBounds : layerOpaqueBounds(materialise(layer, state), state.width, state.height)!;
    next = { before: state, layerId: layer.id, dx: 0, dy: 0, pixels: materialise(layer, state), selection: null, rotation: 0, text: { original: structuredClone(layer.text), initialBounds: { ...bounds }, targetBounds: { ...bounds } } };
    createdTextTransform = true;
  }
  // Every drag of a pending move recomputes from the pixels the transform started with, by the
  // running total offset — never from the previous drag's result. Cutting a selection out of an
  // image it has already been cut out of leaves a second hole, and with a feathered edge a
  // second ring, once per drag, none of which was ever committed.
  const origin = next && !next.text ? next.before.layers.find((item) => item.id === next!.layerId) : null;
  const originSelection = origin ? restrictSelectionToAlpha(next!.before.selection ?? null, materialise(origin, state), state.width, state.height) : null;
  // Content is lifted off the layer once and then placed, never cut again — CLAUDE.md's floating
  // selection lesson: cutting per frame leaves a fraction of a soft edge behind at every position
  // the pointer passed through.
  const float = !next?.text
    ? next?.float ?? liftSelection(origin ? materialise(origin, state) : materialise(layer, state), state.width, state.height, origin ? originSelection : effectiveSelection)
    : undefined;
  const before = next?.before ?? cloneRasterState(pending ? state : { ...state, activeLayerId: layer.id });
  context.setState({
    pending: next,
    drag: {
      kind: "move", pointerId: pointer.pointerId, from: pointer.point, current: pointer.point, before,
      startDx: next?.dx ?? 0, startDy: next?.dy ?? 0,
      basePixels: origin ? materialise(origin, state).slice() : next ? (next.text ? next.pixels : next.pixels.slice()) : materialise(layer, state).slice(),
      baseSelection: origin ? cloneSelection(originSelection) : next?.selection ? cloneSelection(next.selection) : cloneSelection(effectiveSelection),
      rotation: next?.rotation ?? 0,
      ...(next?.text ? { text: next.text } : {}),
      ...(createdTextTransform ? { createdTextTransform: true } : {}),
      ...(origin ? { fromOrigin: true } : {}),
      ...(float ? { float } : {}),
    },
  });
}

/** Recomputes one frame of whichever drag is in progress and previews it — the direct port of
 * the pre-catalogue `applyTransformFrame`, called from `scheduleWork` (per-frame, coalesced)
 * during a drag and once more, synchronously, from `onGestureEnd`. */
function applyDragFrame(context: ToolContext<MoveState>, drag: MoveDrag): PendingTransform | null {
  const state = context.document;
  const point = drag.current;
  if (drag.kind === "scale") {
    const source = drag.sourceBounds;
    let left = source.x, right = source.x + source.width, top = source.y, bottom = source.y + source.height;
    if (drag.handleX === -1) left = point.x; else if (drag.handleX === 1) right = point.x;
    if (drag.handleY === -1) top = point.y; else if (drag.handleY === 1) bottom = point.y;
    const target = { x: Math.min(left, right), y: Math.min(top, bottom), width: Math.max(1, Math.abs(right - left)), height: Math.max(1, Math.abs(bottom - top)) };
    if (drag.text) return { before: drag.before, layerId: drag.before.activeLayerId, dx: drag.dx, dy: drag.dy, pixels: drag.basePixels, selection: drag.baseSelection, rotation: 0, text: { ...drag.text, targetBounds: target } };
    const pixels = scaleLayerPixels(drag.basePixels, state.width, state.height, source, target, drag.baseSelection);
    const selection = scaleSelection(drag.baseSelection, state.width, state.height, source, target);
    const pending: PendingTransform = { before: drag.before, layerId: drag.before.activeLayerId, dx: drag.dx, dy: drag.dy, pixels, selection, rotation: context.state.pending?.rotation ?? 0 };
    context.schedulePreview(pixels, "pixels", pending.layerId);
    return pending;
  }
  if (drag.kind === "rotate") {
    const angle = drag.baseRotation + (Math.atan2(point.y - drag.center.y, point.x - drag.center.x) - drag.startAngle) * 180 / Math.PI;
    if (drag.text) return { before: drag.before, layerId: drag.before.activeLayerId, dx: drag.dx, dy: drag.dy, pixels: drag.basePixels, selection: drag.baseSelection, rotation: angle, text: drag.text };
    const pixels = rotateLayerPixels(drag.basePixels, state.width, state.height, drag.sourceBounds, angle - drag.baseRotation, drag.baseSelection);
    const selection = rotateSelection(drag.baseSelection, state.width, state.height, drag.sourceBounds, angle - drag.baseRotation);
    const pending: PendingTransform = { before: drag.before, layerId: drag.before.activeLayerId, dx: drag.dx, dy: drag.dy, pixels, selection, rotation: angle };
    context.schedulePreview(pixels, "pixels", pending.layerId);
    return pending;
  }
  if (drag.kind === "quad") {
    const dx = point.x - drag.from.x, dy = point.y - drag.from.y;
    const corners = applyQuadHandleDelta(drag.baseCorners, drag.handleIndex, drag.mode, dx, dy);
    const pixels = quadLayerPixels(drag.basePixels, state.width, state.height, drag.sourceBounds, corners, drag.baseSelection);
    const selection = quadSelection(drag.baseSelection, state.width, state.height, drag.sourceBounds, corners);
    const pending: PendingTransform = { before: drag.before, layerId: drag.before.activeLayerId, dx: 0, dy: 0, pixels, selection, rotation: 0, corners };
    context.schedulePreview(pixels, "pixels", pending.layerId);
    return pending;
  }
  if (drag.kind === "warp") {
    const dx = point.x - drag.from.x, dy = point.y - drag.from.y;
    const mesh = drag.baseMesh.map((anchor, index) => index === drag.pointIndex ? { x: anchor.x + dx, y: anchor.y + dy } : anchor);
    const pixels = meshLayerPixels(drag.meshOrigin.pixels, state.width, state.height, drag.meshOrigin.bounds, mesh, drag.baseSelection);
    const selection = meshSelection(drag.baseSelection, state.width, state.height, drag.meshOrigin.bounds, mesh);
    const pending: PendingTransform = { before: drag.before, layerId: drag.before.activeLayerId, dx: 0, dy: 0, pixels, selection, rotation: 0, mesh, meshOrigin: drag.meshOrigin };
    context.schedulePreview(pixels, "pixels", pending.layerId);
    return pending;
  }
  // "move"
  const deltaX = point.x - drag.from.x, deltaY = point.y - drag.from.y, dx = drag.startDx + deltaX, dy = drag.startDy + deltaY;
  if (drag.text) {
    const start = drag.text.targetBounds;
    return { before: drag.before, layerId: drag.before.activeLayerId, dx, dy, pixels: drag.basePixels, selection: drag.baseSelection, rotation: drag.rotation, text: { ...drag.text, targetBounds: { ...start, x: start.x + deltaX, y: start.y + deltaY } } };
  }
  const shiftX = drag.float || drag.fromOrigin ? dx : deltaX;
  const shiftY = drag.float || drag.fromOrigin ? dy : deltaY;
  const working = drag.float
    ? stampFloating(drag.float, state.width, state.height, shiftX, shiftY)
    : translateLayerPixels(drag.basePixels, state.width, state.height, shiftX, shiftY, drag.baseSelection);
  const was = drag.float ? drag.float.bounds : layerOpaqueBounds(drag.basePixels, state.width, state.height);
  const now = was ? { ...was, x: was.x + shiftX, y: was.y + shiftY } : null;
  const touched = [was, now].filter((rect): rect is RasterRect => Boolean(rect));
  const dirty = touched.length ? touched.reduce<RasterRect | null>((accumulated, rect) => unionRect(accumulated, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, 1), null) : null;
  const moved = translateSelection(drag.baseSelection, state.width, state.height, shiftX, shiftY);
  const pending: PendingTransform = { before: drag.before, layerId: drag.before.activeLayerId, dx, dy, pixels: working, selection: moved, rotation: drag.rotation, ...(drag.float ? { float: drag.float } : {}) };
  context.schedulePreview(working, "pixels", pending.layerId, dirty);
  return pending;
}

const move: RasterToolDefinition<MoveState> = {
  id: "raster.move",
  createState: () => empty,

  onPointerDown(context, pointer) {
    const state = context.document;
    const point = pointer.point;
    const pending = context.state.pending;

    if (pending) {
      const tolerance = 11 / context.viewport.zoom;
      const bounds = pendingBounds(pending, state.width, state.height);
      if (!bounds) { context.setState(empty); diagnostic("warn", "transform", "Discarded invalid empty pending transform", { layerId: pending.layerId }); return; }

      if (pending.corners) {
        const mode = String(context.options.transformMode ?? "distort") as QuadTransformMode;
        const nearest = quadHandlePoints(pending.corners, mode).find((entry) => Math.hypot(point.x - entry.point.x, point.y - entry.point.y) <= tolerance);
        if (nearest) {
          context.capturePointer(pointer.pointerId);
          context.setState({ pending, drag: { kind: "quad", pointerId: pointer.pointerId, from: point, current: point, before: pending.before, basePixels: pending.pixels.slice(), baseSelection: cloneSelection(pending.selection), sourceBounds: { ...bounds }, baseCorners: pending.corners, handleIndex: nearest.index, mode } });
          return;
        }
        const xs = pending.corners.map((corner) => corner.x), ys = pending.corners.map((corner) => corner.y);
        if (point.x < Math.min(...xs) || point.x > Math.max(...xs) || point.y < Math.min(...ys) || point.y > Math.max(...ys)) { commitPending(context, pending); context.setState(empty); return; }
      } else if (pending.mesh && pending.meshOrigin) {
        const pointIndex = pending.mesh.findIndex((anchor) => Math.hypot(point.x - anchor.x, point.y - anchor.y) <= tolerance);
        if (pointIndex >= 0) {
          context.capturePointer(pointer.pointerId);
          context.setState({ pending, drag: { kind: "warp", pointerId: pointer.pointerId, from: point, current: point, before: pending.before, meshOrigin: pending.meshOrigin, baseSelection: cloneSelection(pending.selection), baseMesh: pending.mesh, pointIndex } });
          return;
        }
        const xs = pending.mesh.map((anchor) => anchor.x), ys = pending.mesh.map((anchor) => anchor.y);
        if (point.x < Math.min(...xs) || point.x > Math.max(...xs) || point.y < Math.min(...ys) || point.y > Math.max(...ys)) { commitPending(context, pending); context.setState(empty); return; }
      } else {
        const rotatePoint = { x: bounds.x + bounds.width / 2, y: bounds.y - 27 / context.viewport.zoom };
        if (Math.hypot(point.x - rotatePoint.x, point.y - rotatePoint.y) <= tolerance) {
          context.capturePointer(pointer.pointerId);
          const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          context.setState({ pending, drag: { kind: "rotate", pointerId: pointer.pointerId, from: point, current: point, before: pending.before, basePixels: pending.text ? pending.pixels : pending.pixels.slice(), baseSelection: cloneSelection(pending.selection), sourceBounds: { ...bounds }, center, startAngle: Math.atan2(point.y - center.y, point.x - center.x), baseRotation: pending.rotation, dx: pending.dx, dy: pending.dy, ...(pending.text ? { text: pending.text } : {}) } });
          return;
        }
        const handles = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;
        const handle = handles.find(([hx, hy]) => Math.hypot(point.x - (bounds.x + (hx + 1) * bounds.width / 2), point.y - (bounds.y + (hy + 1) * bounds.height / 2)) <= tolerance);
        if (handle) {
          context.capturePointer(pointer.pointerId);
          context.setState({ pending, drag: { kind: "scale", pointerId: pointer.pointerId, from: point, current: point, before: pending.before, basePixels: pending.text ? pending.pixels : pending.pixels.slice(), baseSelection: cloneSelection(pending.selection), sourceBounds: { ...bounds }, handleX: handle[0], handleY: handle[1], dx: pending.dx, dy: pending.dy, ...(pending.text ? { text: pending.text } : {}) } });
          return;
        }
        // Clicking away from the frame accepts the transform, the way it does in Photoshop.
        if (point.x < bounds.x || point.y < bounds.y || point.x > bounds.x + bounds.width || point.y > bounds.y + bounds.height) { commitPending(context, pending); context.setState(empty); return; }
      }
      // Inside the frame, not on a handle: fall through and continue dragging the same pending
      // transform, the way clicking inside an already-open Free Transform does in Photoshop.
      const layer = context.document.layers.find((item) => item.id === pending.layerId) ?? context.activeLayer;
      if (!layer) return;
      if (context.paintTarget.kind !== "mask" && !layerAccepts(layer, "move")) {
        diagnostic("info", "layer.locked", layerLockReason(layer, "move") ?? "Layer is locked", { layerId: layer.id, tool: "raster.move" });
        return;
      }
      beginMoveDrag(context, pointer, pending, layer);
      return;
    }

    // No pending transform: Auto-Select first — clicking something picks the layer it belongs
    // to, instead of moving whatever the panel happens to have highlighted. Photoshop puts this
    // on the Move tool and lets the platform modifier turn it on for one click when it's off.
    let layer = context.activeLayer;
    const wanted = context.options.autoSelect !== false;
    const overridden = pointer.metaKey || pointer.ctrlKey;
    if (wanted !== overridden) {
      const hit = pickLayerAt(state, point.x, point.y, { target: context.options.autoSelectTarget === "group" ? "group" : "layer" });
      if (hit && hit.id !== state.activeLayerId) {
        context.setActiveLayer(hit.id);
        context.setSelectedLayers(pointer.shiftKey ? [...context.selectedLayers.filter((id) => id !== hit.id), hit.id] : [hit.id]);
        layer = hit;
      }
    }
    if (!layer) return;
    if (context.paintTarget.kind !== "mask" && !layerAccepts(layer, "move")) {
      diagnostic("info", "layer.locked", layerLockReason(layer, "move") ?? "Layer is locked", { layerId: layer.id, tool: "raster.move" });
      return;
    }
    beginMoveDrag(context, pointer, pending, layer);
  },

  onPointerMove(context, pointer) {
    const drag = context.state.drag;
    if (!drag || drag.pointerId !== pointer.pointerId) return;
    const nextDrag = { ...drag, current: pointer.point } as MoveDrag;
    context.setState({ pending: context.state.pending, drag: nextDrag });
    // `context.state` is a snapshot taken when this context was built, not a live view — reading
    // it back inside the deferred callback would see the drag as it was *before* the line above,
    // not after. Closing over `nextDrag` (computed just now, synchronously) is what makes the
    // coalescing in `scheduleWork`'s own contract correct: whichever call was scheduled last
    // carries its own accurate position, not a stale re-read of a snapshot that never updates.
    context.scheduleWork(() => {
      const pending = applyDragFrame(context, nextDrag);
      if (pending) context.setState({ pending, drag: nextDrag });
    });
  },

  onGestureEnd(context, pointer) {
    const drag = context.state.drag;
    if (!drag || drag.pointerId !== pointer.pointerId) { context.setState({ pending: context.state.pending, drag: null }); return; }
    if (drag.kind !== "move") { const pending = applyDragFrame(context, drag); context.setState({ pending: pending ?? context.state.pending, drag: null }); return; }
    const deltaX = drag.current.x - drag.from.x, deltaY = drag.current.y - drag.from.y;
    if (Math.hypot(deltaX, deltaY) < .25) {
      // A click, not a drag. A text transform this same click created gets discarded — Photoshop
      // does not leave an empty Free Transform open from a click that moved nothing.
      context.setState({ pending: drag.createdTextTransform ? null : context.state.pending, drag: null });
      return;
    }
    const pending = applyDragFrame(context, drag);
    context.setState({ pending: pending ?? context.state.pending, drag: null });
  },

  onDeactivate(context) {
    const pending = context.state.pending;
    if (pending) commitPending(context, pending);
    if (context.state.pending || context.state.drag) context.setState(empty);
  },

  Overlay({ state, document, options, context }) {
    const pending = state.pending;
    // Enter commits, Escape discards — the same pair every settled-but-uncommitted edit in this
    // project offers, read here rather than at the workspace level because only this Overlay
    // exists while a transform is actually pending. The hook runs unconditionally (React's own
    // rule), the *listener* inside it does nothing when there is nothing pending to act on.
    useEffect(() => {
      if (!pending) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Enter") { event.preventDefault(); commitPending(context, pending); context.setState(empty); }
        else if (event.key === "Escape") { event.preventDefault(); context.setState(empty); context.previewWithLayerHidden(null); }
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [pending, context]);

    // A text transform never touches the document-sized raster during a drag (see
    // PendingTextTransform's own comment): the real layer is hidden and a cheap cropped-pixel
    // canvas stands in for it, positioned/rotated with CSS — the actual glyphs only get
    // re-rendered once, on commit, via renderTextLayerPixels.
    const textPreviewRef = useRef<HTMLCanvasElement>(null);
    const text = pending?.text;
    useEffect(() => {
      if (!text) return;
      context.previewWithLayerHidden(pending!.layerId);
      return () => context.previewWithLayerHidden(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Boolean(text), pending?.layerId]);
    useEffect(() => {
      const overlay = textPreviewRef.current;
      if (!text || !overlay) return;
      const bounds = text.initialBounds;
      overlay.width = Math.max(1, Math.round(bounds.width));
      overlay.height = Math.max(1, Math.round(bounds.height));
      const ctx2d = overlay.getContext("2d");
      if (ctx2d) ctx2d.putImageData(new ImageData(cropPixels(pending!.pixels, document.width, bounds) as Uint8ClampedArray<ArrayBuffer>, overlay.width, overlay.height), 0, 0);
    }, [text?.initialBounds, pending?.pixels, document.width]);

    if (!pending) return null;
    const zoom = context.viewport.zoom;
    const bounds = pendingBounds(pending, document.width, document.height);
    const showControls = options.showTransform !== false;

    if (!showControls || !bounds) return null;
    if (pending.corners) {
      const mode = String(options.transformMode ?? "distort") as QuadTransformMode;
      return <svg className="transform-controls" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
        <polygon className="transform-quad-outline" points={pending.corners.map((corner) => `${corner.x},${corner.y}`).join(" ")}/>
        {quadHandlePoints(pending.corners, mode).map(({ index, point }) => <rect className="transform-handle" key={index} x={point.x - 4 / zoom} y={point.y - 4 / zoom} width={8 / zoom} height={8 / zoom}/>)}
      </svg>;
    }
    if (pending.mesh) {
      return <svg className="transform-controls" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
        {Array.from({ length: WARP_GRID + 1 }, (_, row) => <polyline key={`row-${row}`} className="transform-quad-outline" points={pending.mesh!.slice(row * (WARP_GRID + 1), row * (WARP_GRID + 1) + WARP_GRID + 1).map((anchor) => `${anchor.x},${anchor.y}`).join(" ")}/>)}
        {Array.from({ length: WARP_GRID + 1 }, (_, col) => <polyline key={`col-${col}`} className="transform-quad-outline" points={Array.from({ length: WARP_GRID + 1 }, (_, row) => pending.mesh![row * (WARP_GRID + 1) + col]!).map((anchor) => `${anchor.x},${anchor.y}`).join(" ")}/>)}
        {pending.mesh.map((anchor, index) => <rect className="transform-handle" key={index} x={anchor.x - 4 / zoom} y={anchor.y - 4 / zoom} width={8 / zoom} height={8 / zoom}/>)}
      </svg>;
    }
    return <>
      {text && <canvas ref={textPreviewRef} className="text-transform-preview" style={{ left: text.targetBounds.x, top: text.targetBounds.y, width: text.targetBounds.width, height: text.targetBounds.height, transform: `rotate(${pending.rotation}deg)` }}/>}
      <svg className="transform-controls" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none" aria-hidden="true">
        <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height}/>
        <line className="transform-rotation-stem" x1={bounds.x + bounds.width / 2} y1={bounds.y} x2={bounds.x + bounds.width / 2} y2={bounds.y - 27 / zoom}/>
        <circle className="transform-rotation-handle" cx={bounds.x + bounds.width / 2} cy={bounds.y - 27 / zoom} r={5 / zoom}/>
        {([[0, 0], [.5, 0], [1, 0], [0, .5], [1, .5], [0, 1], [.5, 1], [1, 1]] as [number, number][]).map(([x, y], index) => <rect className="transform-handle" key={index} x={bounds.x + bounds.width * x - 4 / zoom} y={bounds.y + bounds.height * y - 4 / zoom} width={8 / zoom} height={8 / zoom}/>)}
      </svg>
    </>;
  },
};

export default move;
