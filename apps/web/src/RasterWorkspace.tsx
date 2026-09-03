import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  activeRasterLayer, appendLayer, clampRegionToDocument, cloneRasterState, layerAccepts, layerLockReason, layerOpaqueBounds, paintMask, pickLayerAt, compositeRasterDocument, compositeRasterRegion, DirtyRegion, RasterTileCache, cropRasterDocument, floodFill,
  accumulateUniquePixelBytes, changedRenderRegion, confineToSelection, visitPixelBuffers, layerDocumentPixels, mipForZoom, setLayerPixels, isRasterDocumentState, layerRenderSignatures, liftSelection, restrictSelectionToAlpha, rotateLayerPixels, rotateSelection, scaleLayerPixels, scaleSelection, selectionOutlinePath, stampFloating,
  translateLayerPixels, translateSelection, quadLayerPixels, quadSelection, selectionBounds, unionRect, type FloatingPixels, type LayerRenderSignature, type PixelSelection, type Point, type RasterDocumentState, type RasterGuide, type RasterLayer, type RasterRect, type RasterTextData, type SelectionCombineMode,
  RASTER_ASSET_MIME, decodeRasterAsset, encodeRasterAsset, isRasterAsset,
} from "@vravio/env-raster";
import { createBufferRevisionOperation, type AssetId, type VravioDocument } from "@vravio/kernel";
import { kernel } from "./kernel";
import { importModelAsLayer } from "./scene3d-commands";
import { rasterToolById } from "./environments/raster/tools/registry";
import type { PaintTarget, ToolContext, ToolPointer } from "./environments/raster/tools/types";
import { defaultViewport, useShellStore, type DocumentViewport } from "./store";
import { beginBusy } from "./busy";
import { diagnostic } from "./diagnostics";
import { identityTextTransform, multiplyTextTransform, renderTextLayerPixels, textBoundsTransform, textFontString } from "./textRender";
import { localized, text } from "./i18n";
import { useContextMenu } from "./ContextMenu";

/** Asset storage takes plain bytes; a clamped view is not one. */
/**
 * A layer buffer in the form assets hold it.
 *
 * The same container the round-trip uses, so a layer's asset means the same
 * thing whether a brush stroke wrote it or another environment did — and
 * handing that asset to an editor that never saw this document is enough,
 * because the bytes carry their own dimensions.
 */
const toBytes = (pixels: Uint8ClampedArray, width: number, height: number): Uint8Array =>
  encodeRasterAsset(pixels, width, height);

/** Layer bytes out of an asset, tolerating buffers stored before the container existed. */
const fromBytes = (bytes: Uint8Array): Uint8ClampedArray =>
  isRasterAsset(bytes) ? decodeRasterAsset(bytes).pixels : new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

/** Tools that mutate a layer's pixel buffer directly. A non-"pixel" layer (text, and later 3D) must be
 * rasterized into a plain pixel layer before any of these can run — otherwise the tool overwrites baked
 * pixels that are just a cache of the live text/3D data, silently desyncing the two and corrupting the layer. */
const RASTER_ONLY_TOOLS = new Set([
  "raster.clone", "raster.spotHeal", "raster.patch", "raster.fill",
  "raster.brush", "raster.pencil", "raster.highlighter", "raster.eraser",
  "raster.blur", "raster.smudge", "raster.dodge", "raster.burn",
]);
// raster.move is intentionally excluded: Photoshop (and Patchy) let you reposition a text/shape
// layer without rasterizing it first — only pixel-destructive tools require rasterizing.

function putPixels(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray, width: number, height: number): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
}

/** Blits a region-sized buffer at its document offset, leaving the rest of the canvas untouched. */
function putRegionPixels(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray, region: RasterRect, step = 1): void {
  if (!region.width || !region.height) return;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  if (step <= 1) {
    context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, region.width, region.height), region.x, region.y);
    return;
  }
  // A subsampled tile carries one pixel per `step`; the browser scales it back
  // up, which is what makes compositing at a mip level worth doing at all.
  const sampledWidth = Math.ceil(region.width / step), sampledHeight = Math.ceil(region.height / step);
  const source = new OffscreenCanvas(sampledWidth, sampledHeight);
  const sourceContext = source.getContext("2d");
  if (!sourceContext) throw new Error("Canvas 2D is not available");
  sourceContext.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, sampledWidth, sampledHeight), 0, 0);
  context.clearRect(region.x, region.y, region.width, region.height);
  context.drawImage(source, 0, 0, sampledWidth, sampledHeight, region.x, region.y, region.width, region.height);
}

/** Copies one rectangle out of a full-canvas buffer, for the single-layer blit fast path. */
function cropPixels(pixels: Uint8ClampedArray, width: number, region: RasterRect): Uint8ClampedArray {
  const output = new Uint8ClampedArray(region.width * region.height * 4);
  for (let row = 0; row < region.height; row += 1) {
    const start = ((region.y + row) * width + region.x) * 4;
    output.set(pixels.subarray(start, start + region.width * 4), row * region.width * 4);
  }
  return output;
}

function clampZoom(zoom: number): number {
  return Math.max(0.01, Math.min(64, zoom));
}

function rulerStep(zoom: number): number {
  const desiredDocumentPixels = 72 / Math.max(.0001, zoom), power = 10 ** Math.floor(Math.log10(desiredDocumentPixels)), normalized = desiredDocumentPixels / power;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * power;
}

/**
 * How hard the pointer is pressing, on a scale the brush can use.
 *
 * The Pointer Events specification says a device with no pressure sensor must
 * report 0.5 while a button is held, and 0 only when nothing is touching.
 * Safari reports a hard 0 throughout a stroke for pens and touches it has no
 * pressure for, and taking that at face value scales the brush to nothing: a
 * 24-pixel tip becomes 0.6 of a pixel, so the stroke is committed and saved and
 * simply cannot be seen.
 *
 * A zero arriving mid-stroke therefore means "this device is not telling me",
 * not "the user is not pressing".
 */
export function strokePressure(event: { pointerType: string; pressure: number; buttons: number }): number {
  if (event.pointerType === "mouse") return 1;
  if (event.pressure > 0) return Math.max(0.05, event.pressure);
  // Down but reporting nothing: fall back to the value the specification
  // reserves for a device without a sensor.
  return event.buttons === 0 ? 0.05 : 0.5;
}

/**
 * Which way the space bar zooms, given the modifiers held with it.
 *
 * Photoshop makes space plus the platform key a temporary Zoom In, and zooms
 * out with Option and space on macOS or Ctrl+Alt and space on Windows. Both
 * spellings of "out" are accepted rather than sniffing the platform, since they
 * do not collide with anything else here. Space alone stays the Hand tool.
 *
 * On macOS the system claims Cmd+Space for Spotlight, and it wins; zooming out
 * with Option is unaffected.
 */
export function spaceZoomFrom(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): "in" | "out" | null {
  if (event.altKey) return "out";
  return event.metaKey || event.ctrlKey ? "in" : null;
}

function pointFromNativeEvent(workspace: HTMLDivElement, viewport: DocumentViewport, width: number, height: number, event: PointerEvent): Point {
  const rect = workspace.getBoundingClientRect();
  const dx = event.clientX - rect.left - rect.width / 2 - viewport.panX;
  const dy = event.clientY - rect.top - rect.height / 2 - viewport.panY;
  const radians = viewport.rotation * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  return { x: (cosine * dx + sine * dy) / viewport.zoom + width / 2, y: (-sine * dx + cosine * dy) / viewport.zoom + height / 2, pressure: strokePressure(event) };
}

function zoomAroundClient(workspace: HTMLDivElement, viewport: DocumentViewport, zoom: number, clientX: number, clientY: number): Partial<DocumentViewport> {
  const rect = workspace.getBoundingClientRect();
  const x = clientX - rect.left - rect.width / 2, y = clientY - rect.top - rect.height / 2;
  const ratio = zoom / viewport.zoom;
  return { zoom, panX: x - (x - viewport.panX) * ratio, panY: y - (y - viewport.panY) * ratio, mode: "custom" };
}

/**
 * The document with the active layer showing a canvas-sized working buffer.
 *
 * The bounds have to move with the buffer. A layer is stored at the size of its
 * content and read with its own stride, so handing it a canvas-sized buffer
 * while leaving the old rectangle in place makes every row read from the wrong
 * offset — the picture comes out as diagonal streaks.
 */
function withActiveLayerPixels(state: RasterDocumentState, pixels: Uint8ClampedArray): RasterDocumentState {
  const bounds = { x: 0, y: 0, width: state.width, height: state.height };
  return { ...state, layers: state.layers.map((layer) => layer.id === state.activeLayerId ? { ...layer, pixels, bounds, width: state.width, height: state.height } : layer) };
}

function maskToRgba(mask: Uint8ClampedArray): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(mask.length * 4);
  for (let index = 0; index < mask.length; index += 1) { const value = mask[index]!; const offset = index * 4; pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value; pixels[offset + 3] = 255; }
  return pixels;
}

function rgbaToMask(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(pixels.length / 4);
  for (let index = 0; index < mask.length; index += 1) mask[index] = Math.round((pixels[index * 4]! + pixels[index * 4 + 1]! + pixels[index * 4 + 2]!) / 3);
  return mask;
}

function withLayerMaskPixels(state: RasterDocumentState, layerId: string, pixels: Uint8ClampedArray): RasterDocumentState {
  return { ...state, layers: state.layers.map((layer) => layer.id === layerId && layer.mask ? { ...layer, mask: { ...layer.mask, pixels: rgbaToMask(pixels) } } : layer) };
}

/**
 * What a step between these two states actually keeps alive.
 *
 * Both snapshots share their buffers with the document, so charging history for
 * every layer in both of them overstated a single shape by ninety-six megabytes
 * and had the budget dropping undo depth within a dozen operations. Only the
 * buffers the two states disagree about are held open by the step.
 */
function stateDeltaBytes(before: RasterDocumentState, after: RasterDocumentState): number {
  const shared = new Set<ArrayBufferView>();
  accumulateUniquePixelBytes(before, shared);
  // Whatever the two states have in common is already counted, so what this
  // adds is exactly what the step keeps alive on its own.
  const added = accumulateUniquePixelBytes(after, shared);

  const inAfter = new Set<ArrayBufferView>();
  accumulateUniquePixelBytes(after, inAfter);
  let dropped = 0;
  visitPixelBuffers(before, (buffer) => { if (!inAfter.has(buffer)) dropped += buffer.byteLength; });
  return added + dropped;
}

/**
 * Where a layer actually has pixels.
 *
 * Shares the compositor's answer rather than scanning again: it reads four bytes
 * at a time and remembers the result against the buffer, and this is asked the
 * same question about the same buffers all through a gesture.
 */
const alphaBounds = layerOpaqueBounds;

/** The smallest rectangle containing all of these, padded by a pixel. */
function boundingRect(rects: readonly RasterRect[]): RasterRect {
  const left = Math.min(...rects.map((rect) => rect.x)) - 1;
  const top = Math.min(...rects.map((rect) => rect.y)) - 1;
  const right = Math.max(...rects.map((rect) => rect.x + rect.width)) + 1;
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height)) + 1;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

interface PendingTextTransform { original: RasterTextData; initialBounds: RasterRect; targetBounds: RasterRect }

interface PendingPixelTransform {
  before: RasterDocumentState;
  layerId: string;
  dx: number;
  dy: number;
  pixels: Uint8ClampedArray;
  selection: PixelSelection | null;
  rotation: number;
  text?: PendingTextTransform;
  /**
   * Content lifted off the layer, kept for the life of the transform.
   *
   * Carried here so a second drag places the same float instead of cutting a
   * second hole out of an image the first drag already cut from.
   */
  float?: FloatingPixels;
  /**
   * Present once the transform has entered Skew/Distort/Perspective (via the
   * transform tool's right-click menu): the quad the layer's original bounds
   * were warped into, TL/TR/BR/BL. Its absence is what keeps every ordinary
   * move/scale/rotate on the well-tested axis-aligned path — quad mode is
   * additive, not a replacement, and there's no path back out of it within the
   * same pending transform once it's entered.
   */
  corners?: readonly [Point, Point, Point, Point];
  /**
   * Present once the transform has entered Warp: the current 4x4 anchor grid (16 points,
   * row-major), independent of `corners` — a transform is in at most one of the two. Every
   * resample, across however many separate point-drags this Warp session sees, always reads from
   * `meshOrigin`'s pristine pixels and its matching regular grid, never from a previous drag's
   * already-warped result — the only way to drag one corner after another without each pass
   * blurring the last.
   */
  mesh?: readonly Point[];
  meshOrigin?: { pixels: Uint8ClampedArray; bounds: RasterRect };
}

type QuadTransformMode = "skew" | "distort" | "perspective";

/** Which corner (0-3, TL/TR/BR/BL) or, for Skew, which edge-midpoint (4-7, top/right/bottom/left) a quad handle index refers to. */
function quadHandlePoints(corners: readonly [Point, Point, Point, Point], mode: QuadTransformMode): { index: number; point: Point }[] {
  const [tl, tr, br, bl] = corners;
  if (mode !== "skew") return [{ index: 0, point: tl }, { index: 1, point: tr }, { index: 2, point: br }, { index: 3, point: bl }];
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return [{ index: 4, point: mid(tl, tr) }, { index: 5, point: mid(tr, br) }, { index: 6, point: mid(br, bl) }, { index: 7, point: mid(bl, tl) }];
}

/**
 * Applies one handle's cumulative drag (from the gesture's start) to a copy of the corners it
 * started with — recomputed fresh from that base every frame, the same "base plus running
 * total" shape scale/rotate already use, so a fast pointer can't compound rounding error frame
 * over frame.
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

/** Photoshop's default Warp grid: 3x3 cells, so 4x4 draggable anchor points, row-major. */
const WARP_GRID = 3;

/** The undistorted 4x4 anchor grid a warp always resamples from — fixed for the life of one
 * Warp session (see the field comment on PendingPixelTransform.mesh), regardless of how far any
 * point has since been dragged. */
function regularMesh(bounds: RasterRect, gridSize: number): Point[] {
  const points: Point[] = [];
  for (let row = 0; row <= gridSize; row += 1) for (let col = 0; col <= gridSize; col += 1) {
    points.push({ x: bounds.x + (bounds.width * col) / gridSize, y: bounds.y + (bounds.height * row) / gridSize });
  }
  return points;
}

/**
 * Warps basePixels by treating the mesh as a grid of independent quads, each resampled from its
 * own undistorted rectangle of baseBounds via quadLayerPixels — the same engine Skew, Distort and
 * Perspective use, just tiled. Every cell reads from the SAME fixed original pixels (chained
 * through `output` only so later cells composite over earlier ones, never so a cell resamples
 * another cell's already-resampled pixels), which is what keeps a multi-point drag from
 * accumulating resampling blur cell over cell.
 */
function meshLayerPixels(basePixels: Uint8ClampedArray, width: number, height: number, baseBounds: RasterRect, mesh: readonly Point[], selection: PixelSelection | null): Uint8ClampedArray {
  const baseGrid = regularMesh(baseBounds, WARP_GRID);
  let output = basePixels;
  for (let row = 0; row < WARP_GRID; row += 1) for (let col = 0; col < WARP_GRID; col += 1) {
    const i00 = row * (WARP_GRID + 1) + col, i10 = i00 + 1, i01 = i00 + (WARP_GRID + 1), i11 = i01 + 1;
    const tl = baseGrid[i00]!, tr = baseGrid[i10]!, bl = baseGrid[i01]!;
    const cellSource: RasterRect = { x: tl.x, y: tl.y, width: tr.x - tl.x, height: bl.y - tl.y };
    output = quadLayerPixels(output, width, height, cellSource, [mesh[i00]!, mesh[i10]!, mesh[i11]!, mesh[i01]!], selection);
  }
  return output;
}

/** Selection counterpart of meshLayerPixels: each cell's warped mask is folded into one by
 * taking the brighter coverage where two cells' resampling both touch a pixel (they shouldn't
 * for a sane warp, but a max is a safer merge than a plain overwrite if they ever do). */
function meshSelection(selection: PixelSelection | null, width: number, height: number, baseBounds: RasterRect, mesh: readonly Point[]): PixelSelection | null {
  if (!selection) return null;
  const baseGrid = regularMesh(baseBounds, WARP_GRID);
  const mask = new Uint8ClampedArray(width * height);
  for (let row = 0; row < WARP_GRID; row += 1) for (let col = 0; col < WARP_GRID; col += 1) {
    const i00 = row * (WARP_GRID + 1) + col, i10 = i00 + 1, i01 = i00 + (WARP_GRID + 1), i11 = i01 + 1;
    const tl = baseGrid[i00]!, tr = baseGrid[i10]!, bl = baseGrid[i01]!;
    const cellSource: RasterRect = { x: tl.x, y: tl.y, width: tr.x - tl.x, height: bl.y - tl.y };
    const cell = quadSelection(selection, width, height, cellSource, [mesh[i00]!, mesh[i10]!, mesh[i11]!, mesh[i01]!]);
    if (!cell) continue;
    for (let index = 0; index < mask.length; index += 1) mask[index] = Math.max(mask[index]!, cell.mask[index]!);
  }
  const bounds = selectionBounds(mask, width, height);
  return bounds.width && bounds.height ? { mask, bounds } : null;
}

export function RasterWorkspace({ document }: { document: VravioDocument }) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textTransformCanvasRef = useRef<HTMLCanvasElement>(null);
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const documentGesture = useRef<
    | { kind: "move" | "crop"; from: Point; current: Point; pointerId: number; before: RasterDocumentState; startDx: number; startDy: number; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; rotation: number; text?: PendingTextTransform; createdTextTransform?: boolean; /** basePixels is the transform's original, so offsets are the running total. */ fromOrigin?: boolean; /** Content lifted off the layer once; moving places it, never re-cuts. */ float?: FloatingPixels }
    | { kind: "scale"; from: Point; current: Point; pointerId: number; before: RasterDocumentState; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; sourceBounds: RasterRect; handleX: -1 | 0 | 1; handleY: -1 | 0 | 1; dx: number; dy: number; text?: PendingTextTransform }
    | { kind: "rotate"; from: Point; current: Point; pointerId: number; before: RasterDocumentState; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; sourceBounds: RasterRect; center: Point; startAngle: number; baseRotation: number; dx: number; dy: number; text?: PendingTextTransform }
    | { kind: "quad"; from: Point; current: Point; pointerId: number; before: RasterDocumentState; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; sourceBounds: RasterRect; baseCorners: readonly [Point, Point, Point, Point]; handleIndex: number; mode: QuadTransformMode }
    | { kind: "warp"; from: Point; current: Point; pointerId: number; before: RasterDocumentState; meshOrigin: { pixels: Uint8ClampedArray; bounds: RasterRect }; baseSelection: PixelSelection | null; baseMesh: readonly Point[]; pointIndex: number }
    | null
  >(null);
  const pendingTransformRef = useRef<PendingPixelTransform | null>(null);
  // Dev-only window into the transform in flight. Its numbers are the ones that
  // decide what a move produces, and they are otherwise unreachable.
  if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__transform = () => {
    const pending = pendingTransformRef.current;
    return pending && { dx: pending.dx, dy: pending.dy, hasFloat: Boolean(pending.float), layerId: pending.layerId };
  };
  const transformFrameRef = useRef<number | null>(null);
  /** What the last move frame repainted, so the next one can cover it. */
  const movePaintedRef = useRef<RasterRect | null>(null);
  /** Serializes the storage half of pixel commits; see commitPixels. */
  const commitQueue = useRef<Promise<void>>(Promise.resolve());
  const previousActiveLayerId = useRef<string | null>(null);
  const previousToolId = useRef<string | null>(null);
  const navigationGesture = useRef<{ kind: "pan" | "rotate" | "zoom"; pointerId: number; startX: number; startY: number; initial: DocumentViewport; alt: boolean; moved: boolean } | null>(null);
  const tipDragMode = useRef<"angle" | "roundness" | null>(null);
  const sourcePointRef = useRef<{ x: number; y: number } | null>(null);
  const cloneOffsetRef = useRef<{ x: number; y: number } | null>(null);
  /** Where the clone is reading from right now, in document space, for the overlay. */
  const [cloneSourceView, setCloneSourceView] = useState<{ x: number; y: number } | null>(null);
  const cloneSourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastBrushPointRef = useRef<{ toolId: string; layerId: string; point: Point } | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<RasterRect | null>(null);
  const tiles = useRef(new RasterTileCache({ tileSize: 256 }));
  const documentDirty = useRef(new DirtyRegion());
  /** What the visible canvas currently holds, so idle renders repaint nothing. */
  const painted = useRef<{ canvas: HTMLCanvasElement | null; revision: number; signatures?: readonly LayerRenderSignature[]; mip?: number }>({ canvas: null, revision: -1 });
  const [transformPreview, setTransformPreview] = useState<PendingPixelTransform | null>(null);
  const [brushPopup, setBrushPopup] = useState<{ left: number; top: number; detailed: boolean } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  /** "in" or "out" while space and a modifier turn the pointer into a zoom tool. */
  const [spaceZoom, setSpaceZoom] = useState<"in" | "out" | null>(null);
  /** Space's own state, so a modifier pressed after it can be read without a re-render. */
  const spaceDown = useRef(false);
  const [navigating, setNavigating] = useState(false);
  const [preciseCursor, setPreciseCursor] = useState(false);
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });
  const [guideDraft, setGuideDraft] = useState<RasterGuide | null>(null);
  const [rasterizeConfirm, setRasterizeConfirm] = useState<{ layerId: string; layerName: string } | null>(null);
  const language = useShellStore((shell) => shell.language);
  const activeToolId = useShellStore((state) => state.activeToolByDocument[document.id]);
  const toolOptions = useShellStore((state) => state.toolOptions);
  const setSelectedLayers = useShellStore((shell) => shell.setSelectedLayers);
  const selectionEdgesHidden = useShellStore((shell) => shell.selectionEdgesHidden);
  const selectedLayers = useShellStore((shell) => shell.selectedLayerIdsByDocument[document.id]) ?? [];
  const foregroundColor = useShellStore((shell) => shell.foregroundColor);
  const editingMaskLayerId = useShellStore((shell) => shell.editingMaskLayerIdByDocument[document.id] ?? null);
  const maskForegroundIsWhite = useShellStore((shell) => shell.maskForegroundIsWhiteByDocument[document.id] ?? false);
  const setMaskForegroundWhite = useShellStore((shell) => shell.setMaskForegroundWhite);
  const setForegroundColor = useShellStore((shell) => shell.setForegroundColor);
  const setToolOption = useShellStore((shell) => shell.setToolOption);
  const viewport = useShellStore((shell) => shell.viewports[document.id] ?? defaultViewport);
  const setViewport = useShellStore((shell) => shell.setViewport);
  const preferences = useShellStore((shell) => shell.preferences);
  if (!isRasterDocumentState(document.state)) return <div className="workspace-error">Invalid raster document state</div>;
  const state = document.state;
  /**
   * A layer's pixels laid out across the canvas.
   *
   * Layers are stored at the size of what they hold; the tools work in canvas
   * coordinates because a stroke can go anywhere. This is the bridge, and it is
   * cached per buffer, so a layer read repeatedly without being edited is laid
   * out once.
   */
  const canvasPixels = (item: RasterLayer) => layerDocumentPixels(item, state.width, state.height);

  const editingMaskLayer = editingMaskLayerId ? state.layers.find((layer) => layer.id === editingMaskLayerId && layer.mask) ?? null : null;

  /**
   * What restricts the brush right now.
   *
   * Lock Transparency does not forbid painting, it confines it to what the layer
   * already covers — the same shape of restriction a selection is — so the two
   * fold into one mask instead of threading a second concept through every
   * tool. Undefined when nothing restricts, which keeps the unmasked fast path.
   */
  const activeLayerForMask = state.layers.find((layer) => layer.id === state.activeLayerId);
  const brushMask = useMemo(
    () => paintMask(state.selection, activeLayerForMask ? canvasPixels(activeLayerForMask) : new Uint8ClampedArray(0), state.width, state.height, activeLayerForMask?.lockTransparent === true),
    [state.selection, activeLayerForMask?.pixels, activeLayerForMask?.lockTransparent, state.width, state.height],
  );
  const paintColor = editingMaskLayer ? (maskForegroundIsWhite ? "#ffffff" : "#000000") : foregroundColor;

  // Committed edits repaint through the tile cache: only tiles the edit actually touched are
  // recomposited, instead of rebuilding the whole document on every revision (spec §4.2).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // This effect runs on every render, and most renders have nothing to do with
    // the pixels: a history notification, a tool change, a selection. Treating
    // those as "an edit that did not say what it touched" threw away the whole
    // tile cache and recomposited the document — six hundred milliseconds on a
    // fifteen-layer document, several times per operation. The document's
    // revision is what says whether the pixels can have moved at all.
    const canvasChanged = painted.current.canvas !== canvas;
    // Zoomed out, the composite is sampled rather than made at full resolution:
    // at six percent a 1920x1080 canvas is 115 pixels across on screen, and
    // fifteen of every sixteen pixels composited for it are thrown away.
    const mip = mipForZoom(viewport.zoom);
    const revised = document.revision !== painted.current.revision || painted.current.mip !== mip;
    const signatures = layerRenderSignatures(state);
    const previousSignatures = painted.current.signatures;
    painted.current = { canvas, revision: document.revision, signatures, mip };

    // A canvas React has just mounted holds nothing, whatever the cache thinks.
    if (canvasChanged) tiles.current.invalidateAll();
    else if (revised) {
      const pending = documentDirty.current.isEmpty ? null : documentDirty.current.consume();
      if (pending !== null) for (const rect of pending) tiles.current.invalidate(rect);
      else {
        // The edit did not say what it touched — a filter, a layer operation, an
        // undo. Rather than assume the whole document, ask which layers render
        // differently now and repaint what they cover. Null still means "cannot
        // be bounded honestly", and then everything goes.
        const changed = previousSignatures ? changedRenderRegion(previousSignatures, signatures, state) : null;
        if (!changed) tiles.current.invalidateAll();
        else if (changed.width > 0 && changed.height > 0) tiles.current.invalidate(changed);
      }
    }
    const { repainted } = tiles.current.update(state, { x: 0, y: 0, width: state.width, height: state.height }, mip);
    for (const tile of repainted) putRegionPixels(canvas, tile.pixels, tile.rect, tile.step);
  }, [document.revision, state, viewport.zoom]);

  // Destructive adjustment dialogs render a transient composite here. The
  // document, layer pixels and history remain untouched until the dialog's OK
  // button commits one command; cancelling simply redraws the canonical state.
  useEffect(() => {
    const preview = (raw: Event) => {
      const event = raw as CustomEvent<{ documentId: string; pixels: Uint8ClampedArray | null }>;
      if (event.detail.documentId !== document.id) return;
      const canvas = canvasRef.current; if (!canvas) return;
      putPixels(canvas, event.detail.pixels ?? compositeRasterDocument(state), state.width, state.height);
    };
    window.addEventListener("vravio-raster-preview", preview);
    return () => window.removeEventListener("vravio-raster-preview", preview);
  }, [document.id, state]);

  // Text transforms never touch the document-sized raster during a drag. The base
  // canvas is painted once without the active text layer and a cropped overlay is
  // handed to the compositor/GPU for translation, scaling and rotation.
  useEffect(() => {
    const textTransform = transformPreview?.text, overlay = textTransformCanvasRef.current;
    if (!textTransform || !overlay) return;
    const sourceLayer = state.layers.find((item) => item.id === transformPreview.layerId);
    if (!sourceLayer) return;
    const bounds = textTransform.initialBounds;
    overlay.width = Math.max(1, Math.round(bounds.width)); overlay.height = Math.max(1, Math.round(bounds.height));
    putPixels(overlay, cropPixels(canvasPixels(sourceLayer), state.width, bounds), overlay.width, overlay.height);
    const canvas = canvasRef.current;
    if (canvas) putPixels(canvas, compositeRasterDocument({ ...state, layers: state.layers.map((item) => item.id === transformPreview.layerId ? { ...item, visible: false } : item) }), state.width, state.height);
  }, [state, transformPreview?.layerId, transformPreview?.text?.initialBounds, transformPreview?.text?.original]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || viewport.mode !== "fit") return;
    const fit = () => {
      const rect = workspace.getBoundingClientRect();
      const radians = viewport.rotation * Math.PI / 180;
      const cosine = Math.abs(Math.cos(radians)), sine = Math.abs(Math.sin(radians));
      const rotatedWidth = state.width * cosine + state.height * sine;
      const rotatedHeight = state.width * sine + state.height * cosine;
      const zoom = clampZoom(Math.min(Math.max(1, rect.width - 80) / rotatedWidth, Math.max(1, rect.height - 80) / rotatedHeight));
      const current = useShellStore.getState().viewports[document.id] ?? defaultViewport;
      if (Math.abs(current.zoom - zoom) > 0.0001 || current.panX !== 0 || current.panY !== 0) setViewport(document.id, { zoom, panX: 0, panY: 0 });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [document.id, setViewport, state.height, state.width, viewport.mode, viewport.rotation]);

  useEffect(() => {
    const workspace = workspaceRef.current; if (!workspace) return;
    const measure = () => { const rect = workspace.getBoundingClientRect(); setWorkspaceSize((current) => current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(workspace); return () => observer.disconnect();
  }, []);

  // The navigator needs the size of the visible area to draw its viewport frame. Publishing it
  // as an event keeps the measurement out of the shell store, which would otherwise re-render
  // every panel on each resize frame.
  useEffect(() => {
    const publish = () => window.dispatchEvent(new CustomEvent("vravio-viewport-metrics", { detail: { documentId: document.id, workspaceWidth: workspaceSize.width, workspaceHeight: workspaceSize.height } }));
    publish();
    window.addEventListener("vravio-viewport-metrics-request", publish);
    return () => window.removeEventListener("vravio-viewport-metrics-request", publish);
  }, [document.id, workspaceSize.width, workspaceSize.height]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === "INPUT" || target?.tagName === "SELECT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (event.code === "Space" && !editing) { event.preventDefault(); setSpaceHeld(true); }
      // Photoshop turns the space bar into a zoom tool when a modifier joins it:
      // the platform key zooms in, adding Alt zooms out. Tracked as a separate
      // flag because the modifier can be pressed and released while space stays
      // down, and the pointer has to follow it either way.
      if (event.code === "Space" && !editing) spaceDown.current = true;
      if (!editing && spaceDown.current) setSpaceZoom(spaceZoomFrom(event));
      if (event.code === "CapsLock" && !editing) { event.preventDefault(); setPreciseCursor((current) => !current); }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") { spaceDown.current = false; setSpaceHeld(false); setSpaceZoom(null); }
      else if (spaceDown.current) setSpaceZoom(spaceZoomFrom(event));
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => { window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); };
  }, []);

  useEffect(() => {
    const clear = () => kernel.documents.update<RasterDocumentState>(document.id, (current) => { current.guides = []; });
    window.addEventListener("vravio-guides-clear", clear);
    return () => window.removeEventListener("vravio-guides-clear", clear);
  }, [document.id]);

  const renderWorking = (pixels: Uint8ClampedArray, target: "pixels" | "mask" = "pixels", layerId = state.activeLayerId) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (target === "mask") { putPixels(canvas, compositeRasterDocument(withLayerMaskPixels(state, layerId, pixels)), state.width, state.height); return; }
    const layer = activeRasterLayer(state);
    const direct = state.layers.length === 1 && layer.visible && layer.opacity === 1 && layer.blendMode === "normal";
    putPixels(canvas, direct ? pixels : compositeRasterDocument(withActiveLayerPixels(state, pixels)), state.width, state.height);
  };

  /**
   * Repaints only the area the stroke has touched since the last frame. Compositing the whole
   * document every pointermove is what makes brushes stutter on large canvases (spec §4.2), and
   * a stroke only ever changes a few hundred pixels around the cursor.
   */
  const renderWorkingRegion = (pixels: Uint8ClampedArray, dirty: RasterRect) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const region = clampRegionToDocument(state, dirty);
    if (!region.width || !region.height) return;
    const layer = activeRasterLayer(state);
    const direct = state.layers.length === 1 && layer.visible && layer.opacity === 1 && layer.blendMode === "normal";
    putRegionPixels(canvas, direct ? cropPixels(pixels, state.width, region) : compositeRasterRegion(withActiveLayerPixels(state, pixels), region), region);
  };

  const applyTransformFrame = (transforming: NonNullable<typeof documentGesture.current>) => {
    const point = transforming.current;
    if (transforming.kind === "scale") {
      const source = transforming.sourceBounds;
      let left = source.x, right = source.x + source.width, top = source.y, bottom = source.y + source.height;
      if (transforming.handleX === -1) left = point.x; else if (transforming.handleX === 1) right = point.x;
      if (transforming.handleY === -1) top = point.y; else if (transforming.handleY === 1) bottom = point.y;
      const target = { x: Math.min(left, right), y: Math.min(top, bottom), width: Math.max(1, Math.abs(right - left)), height: Math.max(1, Math.abs(bottom - top)) };
      if (transforming.text) {
        const current = pendingTransformRef.current; if (!current) return;
        const preview: PendingPixelTransform = { ...current, text: { ...transforming.text, targetBounds: target } };
        pendingTransformRef.current = preview; setTransformPreview(preview); announceTransform(preview); return;
      }
      const pixels = scaleLayerPixels(transforming.basePixels, state.width, state.height, source, target, transforming.baseSelection);
      const selection = scaleSelection(transforming.baseSelection, state.width, state.height, source, target);
      const preview = { before: transforming.before, layerId: transforming.before.activeLayerId, dx: transforming.dx, dy: transforming.dy, pixels, selection, rotation: pendingTransformRef.current?.rotation ?? 0 };
      pendingTransformRef.current = preview; setTransformPreview(preview); announceTransform(preview); renderWorking(pixels);
    } else if (transforming.kind === "rotate") {
      const angle = transforming.baseRotation + (Math.atan2(point.y - transforming.center.y, point.x - transforming.center.x) - transforming.startAngle) * 180 / Math.PI;
      if (transforming.text) {
        const current = pendingTransformRef.current; if (!current) return;
        const preview: PendingPixelTransform = { ...current, rotation: angle, text: transforming.text };
        pendingTransformRef.current = preview; setTransformPreview(preview); announceTransform(preview); return;
      }
      const pixels = rotateLayerPixels(transforming.basePixels, state.width, state.height, transforming.sourceBounds, angle - transforming.baseRotation, transforming.baseSelection);
      const selection = rotateSelection(transforming.baseSelection, state.width, state.height, transforming.sourceBounds, angle - transforming.baseRotation);
      const preview = { before: transforming.before, layerId: transforming.before.activeLayerId, dx: transforming.dx, dy: transforming.dy, pixels, selection, rotation: angle };
      pendingTransformRef.current = preview; setTransformPreview(preview); announceTransform(preview); renderWorking(pixels);
    } else if (transforming.kind === "quad") {
      const dx = point.x - transforming.from.x, dy = point.y - transforming.from.y;
      const corners = applyQuadHandleDelta(transforming.baseCorners, transforming.handleIndex, transforming.mode, dx, dy);
      const pixels = quadLayerPixels(transforming.basePixels, state.width, state.height, transforming.sourceBounds, corners, transforming.baseSelection);
      const selection = quadSelection(transforming.baseSelection, state.width, state.height, transforming.sourceBounds, corners);
      const preview: PendingPixelTransform = { before: transforming.before, layerId: transforming.before.activeLayerId, dx: 0, dy: 0, pixels, selection, rotation: 0, corners };
      pendingTransformRef.current = preview; setTransformPreview(preview); announceTransform(preview); renderWorking(pixels);
    } else if (transforming.kind === "warp") {
      const dx = point.x - transforming.from.x, dy = point.y - transforming.from.y;
      const mesh = transforming.baseMesh.map((anchor, index) => index === transforming.pointIndex ? { x: anchor.x + dx, y: anchor.y + dy } : anchor);
      const pixels = meshLayerPixels(transforming.meshOrigin.pixels, state.width, state.height, transforming.meshOrigin.bounds, mesh, transforming.baseSelection);
      const selection = meshSelection(transforming.baseSelection, state.width, state.height, transforming.meshOrigin.bounds, mesh);
      const preview: PendingPixelTransform = { before: transforming.before, layerId: transforming.before.activeLayerId, dx: 0, dy: 0, pixels, selection, rotation: 0, mesh, meshOrigin: transforming.meshOrigin };
      pendingTransformRef.current = preview; setTransformPreview(preview); announceTransform(preview); renderWorking(pixels);
    } else if (transforming.kind === "move") {
      const deltaX = point.x - transforming.from.x, deltaY = point.y - transforming.from.y, dx = transforming.startDx + deltaX, dy = transforming.startDy + deltaY;
      if (transforming.text) {
        const current = pendingTransformRef.current; if (!current) return;
        const start = transforming.text.targetBounds;
        const preview: PendingPixelTransform = { ...current, dx, dy, text: { ...transforming.text, targetBounds: { ...start, x: start.x + deltaX, y: start.y + deltaY } } };
        pendingTransformRef.current = preview; setTransformPreview(preview); announceTransform(preview); return;
      }
      // The offset is the running total whenever the base is the transform's
      // original — which a float always is, since it was lifted from it.
      const shiftX = transforming.float || transforming.fromOrigin ? dx : deltaX;
      const shiftY = transforming.float || transforming.fromOrigin ? dy : deltaY;
      const working = transforming.float
        ? stampFloating(transforming.float, state.width, state.height, shiftX, shiftY)
        : translateLayerPixels(transforming.basePixels, state.width, state.height, shiftX, shiftY, transforming.baseSelection);
      // Only where the content was and where it went can have changed. Redrawing
      // the whole canvas each frame composited the entire document to move a
      // square across it. The previous frame's area is folded in as well, or a
      // fast drag would leave the layer painted where it no longer is.
      const was = transforming.float ? transforming.float.bounds : layerOpaqueBounds(transforming.basePixels, state.width, state.height);
      const now = was ? { ...was, x: was.x + shiftX, y: was.y + shiftY } : null;
      const touched = [movePaintedRef.current, was, now].filter((rect): rect is RasterRect => Boolean(rect));
      if (touched.length) {
        const region = boundingRect(touched);
        movePaintedRef.current = region;
        renderWorkingRegion(working, region);
      } else renderWorking(working);
      const moved = translateSelection(transforming.baseSelection, state.width, state.height, shiftX, shiftY);
      const preview = { before: transforming.before, layerId: transforming.before.activeLayerId, dx, dy, pixels: working, selection: moved, rotation: transforming.rotation, ...(transforming.float ? { float: transforming.float } : {}) };
      pendingTransformRef.current = preview;
      setTransformPreview(preview);
      announceTransform(preview);
    }
  };

  const scheduleTransformFrame = (transforming: NonNullable<typeof documentGesture.current>) => {
    if (transformFrameRef.current !== null) return;
    transformFrameRef.current = requestAnimationFrame(() => {
      transformFrameRef.current = null;
      if (documentGesture.current === transforming) applyTransformFrame(transforming);
    });
  };

  const renderSpotHealOverlay = (mask: Uint8ClampedArray, originX: number, originY: number, maskW: number, maskH: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderWorking(canvasPixels(activeRasterLayer(state)));
    const imageData = ctx.getImageData(0, 0, state.width, state.height);
    const px = imageData.data;
    for (let y = 0; y < maskH; y++) {
      for (let x = 0; x < maskW; x++) {
        const m = mask[y * maskW + x]!;
        if (m === 0) continue;
        const idx = ((originY + y) * state.width + (originX + x)) * 4;
        const a = m / 255 * 0.5;
        px[idx] = Math.round(px[idx]! * (1 - a) + 40 * a);
        px[idx + 1] = Math.round(px[idx + 1]! * (1 - a) + 40 * a);
        px[idx + 2] = Math.round(px[idx + 2]! * (1 - a) + 40 * a);
      }
    }
    ctx.putImageData(imageData, 0, 0);
  };

  /**
   * Records a destructive pixel edit.
   *
   * The edit lands in the document first and is written to the asset store
   * afterwards. That order matters: the store is on OPFS, and a full layer is
   * eight megabytes each way, so making the document wait for it left a window
   * of tens of milliseconds after the pointer came up in which the layer still
   * held the previous pixels. A second stroke started inside that window read
   * the stale buffer and was lost when the first commit finally landed.
   *
   * The buffers go to the asset store and the history step keeps two revision
   * numbers. Holding the before and after buffers inside the step instead would
   * cost 16 MB per stroke on a 1920x1080 layer, and the memory budget would
   * start dropping undo depth after a dozen strokes.
   */
  const commitPixels = async (before: Uint8ClampedArray, after: Uint8ClampedArray, label: string, target: "pixels" | "mask" = "pixels", layerId = state.activeLayerId, bounds?: RasterRect | null) => {
    if (bounds) documentDirty.current.add(bounds);
    const history = kernel.historyByDocument.get(document.id);
    if (!history) throw new Error(`History missing for ${document.id}`);
    const assign = (pixels: Uint8Array | Uint8ClampedArray): void => {
      const buffer = pixels instanceof Uint8ClampedArray ? pixels : fromBytes(pixels);
      kernel.documents.update<RasterDocumentState>(document.id, (current) => {
        const layer = current.layers.find((item) => item.id === layerId);
        if (!layer) return;
        if (target === "mask" && layer.mask) { layer.mask.pixels = rgbaToMask(buffer); return; }
        // Stored at the size of what was painted, not the size of the canvas.
        // The tool worked at canvas size because a stroke can go anywhere; what
        // is kept afterwards is the part that has something in it.
        setLayerPixels(layer, buffer, current.width, current.height);
      });
    };

    // A selection confines every tool, without exception. Each tool honours it
    // while painting, but this is the guarantee: an edit that reached here
    // having touched pixels outside the selection has them put back, so a tool
    // added later cannot quietly escape it.
    const confined = target === "pixels" && state.selection ? confineToSelection(before, after, state.selection.mask) : after;

    // Show the result now; the gesture is over and the user is looking at it.
    assign(confined);

    // Queue the bookkeeping. Two commits must not interleave: each reads the
    // asset head to name the revision it undoes to, and a head read between
    // another commit's write and its own would record a step that undoes to
    // the wrong picture.
    commitQueue.current = commitQueue.current
      .catch(() => undefined)
      .then(async () => {
        const assetId = await ensureBufferAsset(layerId, target, before, label);
        if (!assetId) {
          // No asset store available: fall back to buffer snapshots so the edit
          // is still reversible, just at the old memory cost.
          await history.record({ label, memoryEstimate: before.byteLength + confined.byteLength, redo: () => assign(confined), undo: () => assign(before) });
          return;
        }
        const previousRev = kernel.assets.mustGet(assetId).head;
        // The confined buffer, not the raw one: this revision is what redo and
        // any later reload restore from, so committing the unconfined edit here
        // would show the selection honoured and then quietly undo that on the
        // first redo. Every current tool masks as it paints, which is why the
        // two agree today; the guarantee above is for the one that does not.
        const nextRev = await kernel.assets.commitRevision(assetId, toBytes(confined, state.width, state.height), "raster", label);
        await history.record(createBufferRevisionOperation({ assets: kernel.assets, assetId, label, producedBy: "raster", apply: assign }, previousRev, nextRev));
      });
    await commitQueue.current;
  };

  /** Binds a layer buffer to an asset on first edit, seeding it with the pre-edit bytes. */
  const ensureBufferAsset = async (layerId: string, target: "pixels" | "mask", before: Uint8ClampedArray, label: string): Promise<AssetId | null> => {
    await kernel.assetsReady;
    // Read the live document, not the state this render closed over: commits are
    // queued, so by the time this runs an earlier one may already have bound the
    // asset, and working from the stale copy would bind a second one.
    const live = kernel.documents.get<RasterDocumentState>(document.id)?.state;
    const layer = live?.layers.find((item) => item.id === layerId);
    if (!layer) return null;

    const key = target === "mask" ? "maskAssetId" : "pixelAssetId";
    const existing = layer[key];
    if (existing && kernel.assets.has(existing)) return existing as AssetId;

    const assetId = await kernel.assets.importAsset(toBytes(before, state.width, state.height), { kind: "image", name: `${layer.name}.${target}.vraster`, mime: RASTER_ASSET_MIME });
    kernel.documents.update<RasterDocumentState>(document.id, (current) => {
      const target_ = current.layers.find((item) => item.id === layerId);
      if (target_) target_[key] = assetId;
    });
    kernel.documents.addAssetRef(document.id, assetId);
    void label;
    return assetId;
  };

  const commitDocumentState = async (before: RasterDocumentState, after: RasterDocumentState, label: string) => {
    const history = kernel.historyByDocument.get(document.id);
    if (!history) throw new Error(`History missing for ${document.id}`);
    const assign = (snapshot: RasterDocumentState): void => { kernel.documents.update<RasterDocumentState>(document.id, (current) => { Object.assign(current, cloneRasterState(snapshot)); }); };
    await history.execute({ label, memoryEstimate: stateDeltaBytes(before, after), redo: () => assign(after), undo: () => assign(before) });
  };

  const confirmRasterize = () => {
    if (!rasterizeConfirm) return;
    const done = beginBusy("Rasterising layer (Растеризация слоя)");
    try {
    const before = cloneRasterState(state), after = cloneRasterState(state);
    const target = after.layers.find((item) => item.id === rasterizeConfirm.layerId);
    if (target) { target.kind = "pixel"; delete target.text; delete target.adjustment; }
    setRasterizeConfirm(null);
    void commitDocumentState(before, after, "Rasterize Layer (Растрировать слой)");
    } finally { done(); }
  };

  const announceTransform = (pending: PendingPixelTransform | null) => {
    const bounds = pending?.text?.targetBounds ?? pending?.selection?.bounds ?? (pending ? alphaBounds(pending.pixels, state.width, state.height) : null);
    window.dispatchEvent(new CustomEvent("vravio-transform-state", { detail: pending && bounds ? { active: true, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, rotation: pending.rotation } : null }));
  };

  const finishPendingTransform = (commit: boolean, nextActiveLayerId?: string) => {
    const pending = pendingTransformRef.current;
    movePaintedRef.current = null;
    if (!pending) return;
    pendingTransformRef.current = null;
    setTransformPreview(null);
    announceTransform(null);
    diagnostic("info", "transform", commit ? "Transform committed" : "Transform cancelled", { documentId: document.id, layerId: pending.layerId, dx: pending.dx, dy: pending.dy });
    if (!commit) { const canvas = canvasRef.current; if (canvas) putPixels(canvas, compositeRasterDocument(state), state.width, state.height); return; }
    if (pending.text) {
      const history = kernel.historyByDocument.get(document.id);
      if (!history) return;
      const beforeText = structuredClone(pending.text.original);
      const delta = textBoundsTransform(pending.text.initialBounds, pending.text.targetBounds, pending.rotation);
      const afterText = { ...beforeText, transform: multiplyTextTransform(delta, beforeText.transform ?? identityTextTransform()) };
      const assign = (value: RasterTextData) => kernel.documents.update<RasterDocumentState>(document.id, (current) => {
        const target = current.layers.find((item) => item.id === pending.layerId); if (!target) return;
        const started = performance.now();
        target.text = structuredClone(value); target.pixels = renderTextLayerPixels(target.text, current.width, current.height);
        const elapsedMs = performance.now() - started;
        diagnostic(elapsedMs > 50 ? "warn" : "info", "text.transform", `Text raster cache rebuilt in ${elapsedMs.toFixed(1)} ms`, { documentId: document.id, layerId: pending.layerId, width: current.width, height: current.height });
      });
      void history.execute({ label: "Transform Type Layer (Трансформация текстового слоя)", memoryEstimate: JSON.stringify(beforeText).length + JSON.stringify(afterText).length, redo: () => { assign(afterText); }, undo: () => { assign(beforeText); } });
      return;
    }
    // Committing rewrites the layer and repaints; on a large document that is
    // long enough to want a sign that something is happening.
    const doneBusy = beginBusy("Applying (Применение)");
    queueMicrotask(doneBusy);
    const after = cloneRasterState(pending.before);
    const layer = after.layers.find((item) => item.id === pending.layerId);
    if (layer) {
      // Say what moved. Without this the repaint has no region to work from and
      // recomposites the whole document, which on a layered file is most of the
      // pause between letting go and seeing the result.
      const sourceLayer = pending.before.layers.find((item) => item.id === pending.layerId);
      const wasThere = sourceLayer ? alphaBounds(canvasPixels(sourceLayer), state.width, state.height) : null;
      const isThere = alphaBounds(pending.pixels, state.width, state.height);
      if (wasThere) documentDirty.current.add(wasThere);
      if (isThere) documentDirty.current.add(isThere);
      if (!wasThere && !isThere) documentDirty.current.addEverything();
      setLayerPixels(layer, pending.pixels, state.width, state.height);
    }
    after.selection = pending.selection ? { mask: pending.selection.mask.slice(), bounds: { ...pending.selection.bounds } } : null;
    if (nextActiveLayerId) after.activeLayerId = nextActiveLayerId;
    void commitDocumentState(pending.before, after, "Commit Transform (Применить трансформацию)");
  };

  useEffect(() => {
    const start = () => {
      if (pendingTransformRef.current) return;
      const sourceLayer = activeRasterLayer(state), liveText = sourceLayer.kind === "text" && sourceLayer.text && !state.selection;
      const before = liveText ? state : cloneRasterState(state), layer = liveText ? sourceLayer : activeRasterLayer(before);
      const selection = before.selection ? restrictSelectionToAlpha(before.selection, canvasPixels(layer), state.width, state.height) : null;
      if (before.selection && !selection) { diagnostic("info", "transform", "Transform ignored: selection contains no opaque pixels", { documentId: document.id, layerId: layer.id }); return; }
      if (!selection && !alphaBounds(canvasPixels(layer), state.width, state.height)) { diagnostic("info", "transform", "Transform ignored: layer is empty", { documentId: document.id, layerId: layer.id }); return; }
      const bounds = layer.text?.visualBounds?.width ? layer.text.visualBounds : alphaBounds(canvasPixels(layer), state.width, state.height)!;
      const pending: PendingPixelTransform = { before, layerId: layer.id, dx: 0, dy: 0, pixels: canvasPixels(layer).slice(), selection, rotation: 0, ...(liveText ? { text: { original: structuredClone(layer.text!), initialBounds: { ...bounds }, targetBounds: { ...bounds } } } : {}) };
      pendingTransformRef.current = pending; setTransformPreview(pending); announceTransform(pending);
    };
    const commit = () => finishPendingTransform(true), cancel = () => finishPendingTransform(false);
    window.addEventListener("vravio-transform-start", start); window.addEventListener("vravio-transform-commit", commit); window.addEventListener("vravio-transform-cancel", cancel);
    return () => { window.removeEventListener("vravio-transform-start", start); window.removeEventListener("vravio-transform-commit", commit); window.removeEventListener("vravio-transform-cancel", cancel); };
  });

  useEffect(() => {
    const previous = previousActiveLayerId.current;
    previousActiveLayerId.current = state.activeLayerId;
    if (previous && previous !== state.activeLayerId && pendingTransformRef.current?.layerId === previous) finishPendingTransform(true, state.activeLayerId);
  }, [state.activeLayerId]);

  useEffect(() => {
    const previous = previousToolId.current;
    previousToolId.current = activeToolId ?? null;
    if (previous && previous !== activeToolId && pendingTransformRef.current) finishPendingTransform(true);
  }, [activeToolId]);

  useEffect(() => () => {
    pendingTransformRef.current = null;
    window.dispatchEvent(new CustomEvent("vravio-transform-state", { detail: null }));
  }, [document.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pendingTransformRef.current) return;
      if (event.key === "Enter") { event.preventDefault(); finishPendingTransform(true); }
      if (event.key === "Escape") { event.preventDefault(); finishPendingTransform(false); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const commitSelection = async (before: PixelSelection | null, after: PixelSelection | null, label = "Marquee Selection (Прямоугольное выделение)") => {
    const history = kernel.historyByDocument.get(document.id);
    if (!history) throw new Error(`History missing for ${document.id}`);
    const clone = (selection: PixelSelection | null): PixelSelection | null => selection ? { mask: selection.mask.slice(), bounds: { ...selection.bounds } } : null;
    const assign = (selection: PixelSelection | null): void => { kernel.documents.update<RasterDocumentState>(document.id, (current) => { current.selection = clone(selection); }); };
    await history.execute({ label, memoryEstimate: (before?.mask.byteLength ?? 0) + (after?.mask.byteLength ?? 0), redo: () => assign(after), undo: () => assign(before) });
  };

  /**
   * The bridge to the tool catalogue (stage 3 of docs/migration-plan.md).
   *
   * A tool that has a file under `environments/raster/tools/definitions/`
   * runs through its hooks and never reaches the switch below; everything
   * else still goes through the switch, unchanged. Both paths stay live
   * until the last tool has moved, because porting twenty-nine tools in one
   * change is how a rewrite breaks an editor.
   */
  const catalogueTool = activeToolId ? rasterToolById.get(activeToolId) : undefined;
  // One state slot per tool id. Held here rather than inside the tool so a
  // tool file stays a plain object with no hooks of its own, and so switching
  // tools cannot leave a half-finished gesture running.
  const [toolStates, setToolStates] = useState<Record<string, unknown>>({});
  const toolStatesRef = useRef(toolStates);
  // A catalogue tool's own RAF-coalesced preview writer — decoupled from the
  // legacy `gesture` ref, which stays exclusively for the not-yet-ported
  // tonal tools, so the two paths cannot interfere with each other.
  const previewFrameRef = useRef<{ frame: number | null; dirty: RasterRect | null; working: Uint8ClampedArray; target: "pixels" | "mask"; layerId: string } | null>(null);
  toolStatesRef.current = toolStates;

  const toolPointerFromNative = (native: PointerEvent, workspace: HTMLDivElement, rect: DOMRect): ToolPointer => ({
    point: pointFromNativeEvent(workspace, viewport, state.width, state.height, native),
    screenX: native.clientX - rect.left,
    screenY: native.clientY - rect.top,
    pointerId: native.pointerId,
    shiftKey: native.shiftKey, altKey: native.altKey, ctrlKey: native.ctrlKey, metaKey: native.metaKey,
    button: native.button, pressure: native.pressure,
  });

  const toolPointerFrom = (event: React.PointerEvent<HTMLCanvasElement>): ToolPointer | null => {
    const workspace = workspaceRef.current;
    if (!workspace) return null;
    return toolPointerFromNative(event.nativeEvent, workspace, workspace.getBoundingClientRect());
  };

  const toolContextFor = (toolId: string, canvas: HTMLCanvasElement | null): ToolContext<unknown> => {
    const tool = rasterToolById.get(toolId);
    const current = toolStatesRef.current[toolId] ?? tool?.createState();
    // Painting always targets either the active layer's own pixels or, while
    // editing one, its mask — the same distinction commitPixels' own `target`
    // parameter already carries. Resolved once here rather than by each tool,
    // since it depends on the shell's editing-mask state, not on the tool.
    const maskTarget = editingMaskLayer?.id === state.activeLayerId ? editingMaskLayer : null;
    const activeLayer = activeRasterLayer(state) ?? null;
    const paintTarget: PaintTarget = maskTarget ? { kind: "mask", layerId: maskTarget.id } : { kind: "pixels", layerId: activeLayer?.id ?? state.activeLayerId };
    return {
      documentId: document.id,
      document: state,
      viewport,
      options: (toolOptions[toolId] ?? {}) as Readonly<Record<string, string | number | boolean>>,
      activeLayer,
      selection: state.selection,
      spaceHeld,
      state: current,
      setState: (next) => {
        toolStatesRef.current = { ...toolStatesRef.current, [toolId]: next };
        setToolStates(toolStatesRef.current);
      },
      capturePointer: (pointerId) => canvas?.setPointerCapture(pointerId),
      layerPixels: () => (activeLayer ? canvasPixels(activeLayer) : new Uint8ClampedArray(state.width * state.height * 4)),
      compositePixels: () => compositeRasterDocument(state),
      paintTarget,
      paintColor,
      paintMask: brushMask,
      targetPixels: () => (maskTarget?.mask ? maskToRgba(maskTarget.mask.pixels) : (activeLayer ? canvasPixels(activeLayer) : new Uint8ClampedArray(state.width * state.height * 4)).slice()),
      schedulePreview: (pixels, target, layerId, dirty) => {
        let current = previewFrameRef.current;
        if (!current || current.target !== target || current.layerId !== layerId) {
          current = { frame: null, dirty: null, working: pixels, target, layerId };
          previewFrameRef.current = current;
        } else {
          current.working = pixels;
        }
        if (dirty) current.dirty = current.dirty ? unionRect(current.dirty, dirty.x, dirty.y, dirty.x + dirty.width, dirty.y + dirty.height, 0) : dirty;
        if (current.frame !== null) return;
        const entry = current;
        entry.frame = requestAnimationFrame(() => {
          entry.frame = null;
          const region = entry.dirty;
          entry.dirty = null;
          // Matches scheduleWorkingRender's own dispatch exactly, quirk
          // included: a dirty region always takes the pixels-only fast path
          // regardless of target, because renderWorkingRegion (unlike
          // renderWorking) has no mask-compositing branch. A masked stroke's
          // live preview is briefly the pixel-layer composite until the
          // gesture ends and the real commit repaints correctly — a
          // pre-existing cosmetic quirk of the path this reuses, not
          // something this port introduces or should quietly diverge from.
          if (region && entry.target === "pixels") renderWorkingRegion(entry.working, region);
          else renderWorking(entry.working, entry.target, entry.layerId);
        });
      },
      commit: (before, after, label, target = paintTarget.kind, layerId = paintTarget.layerId, bounds = null) => commitPixels(before, after, label, target, layerId, bounds),
      commitSelection: (before, after, label) => commitSelection(before, after, label),
      commitDocument: (before, after, label, bounds) => { if (bounds) documentDirty.current.add(bounds); return commitDocumentState(before, after, label); },
      setActiveLayer: (layerId) => kernel.documents.update<RasterDocumentState>(document.id, (current) => { current.activeLayerId = layerId; }),
      foregroundColor,
      setForegroundColor,
      previewWithLayerHidden: (layerId) => {
        if (!canvas) return;
        putPixels(canvas, layerId ? compositeRasterDocument({ ...state, layers: state.layers.map((item) => item.id === layerId ? { ...item, visible: false } : item) }) : compositeRasterDocument(state), state.width, state.height);
      },
      setMaskForegroundWhite: (white) => setMaskForegroundWhite(document.id, white),
      lastStrokePoint: lastBrushPointRef.current,
      setLastStrokePoint: (next) => { lastBrushPointRef.current = next; },
      cloneSource: sourcePointRef.current,
      setCloneSource: (point) => { sourcePointRef.current = point; },
      cloneOffset: cloneOffsetRef.current,
      setCloneOffset: (offset) => { cloneOffsetRef.current = offset; },
      previewSpotHealMask: (mask, originX, originY, width, height) => renderSpotHealOverlay(mask, originX, originY, width, height),
    };
  };

  // Tool state is kept per id and outlives a switch, so the tool being left
  // has to be told to let go of it. Without this, changing tool mid-press
  // strands the gesture and picking the tool back up draws it again.
  const previousToolRef = useRef(activeToolId);
  useEffect(() => {
    const previous = previousToolRef.current;
    previousToolRef.current = activeToolId;
    if (previous === activeToolId || !previous) return;
    const leaving = rasterToolById.get(previous);
    leaving?.onDeactivate?.(toolContextFor(previous, null));
  });

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2) return;
    const canvas = event.currentTarget;
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const point = pointFromNativeEvent(workspace, viewport, state.width, state.height, event.nativeEvent);

    // Auto-Select: clicking something picks the layer it belongs to, instead of
    // moving whatever the panel happens to have highlighted. Photoshop puts this
    // on the Move tool and lets the platform modifier turn it on for one click
    // when the option is off, so a deliberate move of the selected layer is
    // still possible over the top of something else.
    let autoSelected: RasterLayer | null = null;
    if (activeToolId === "raster.move" && !pendingTransformRef.current) {
      const options = toolOptions["raster.move"] ?? {};
      const wanted = options.autoSelect !== false;
      const overridden = event.metaKey || event.ctrlKey;
      if (wanted !== overridden) {
        const hit = pickLayerAt(state, point.x, point.y, { target: options.autoSelectTarget === "group" ? "group" : "layer" });
        if (hit && hit.id !== state.activeLayerId) {
          kernel.documents.update<RasterDocumentState>(document.id, (current) => { current.activeLayerId = hit.id; });
          setSelectedLayers(document.id, event.shiftKey ? [...selectedLayers.filter((id) => id !== hit.id), hit.id] : [hit.id]);
          // Picking and dragging are one gesture, so the rest of this handler runs
          // against the layer just picked rather than waiting for React to
          // re-render with it. The snapshots below have to agree, or the move
          // would be recorded against whichever layer was selected before.
          autoSelected = hit;
        }
      }
    }
    const gestureState = autoSelected ? { ...state, activeLayerId: autoSelected.id } : state;

    const layer = autoSelected ?? activeRasterLayer(state);
    const maskTarget = editingMaskLayer?.id === state.activeLayerId ? editingMaskLayer : null;
    const paintTargetId = maskTarget?.id ?? layer.id;
    const brushTargetKey = maskTarget ? `mask:${maskTarget.id}` : layer.id;

    if (catalogueTool?.onPointerDown) {
      // Same gate RASTER_ONLY_TOOLS enforced for the switch below: a tool
      // that needs real pixels to write into is not allowed to write into a
      // text or adjustment layer's cached preview — that would desync it
      // from the data it is actually drawn from silently. Editing a mask is
      // always pixels regardless of the layer's own kind, which is why
      // maskTarget exempts it.
      if (!maskTarget && catalogueTool.requiresRasterized && layer.kind !== "pixel") {
        setRasterizeConfirm({ layerId: layer.id, layerName: layer.name });
        return;
      }
      const pointer = toolPointerFrom(event);
      if (pointer) { catalogueTool.onPointerDown(toolContextFor(catalogueTool.id, canvas), pointer); return; }
    }
    const pendingTransform = pendingTransformRef.current;
    if (pendingTransform) {
      const bounds = pendingTransform.text?.targetBounds ?? pendingTransform.selection?.bounds ?? alphaBounds(pendingTransform.pixels, state.width, state.height), tolerance = 11 / viewport.zoom;
      if (!bounds) { pendingTransformRef.current = null; setTransformPreview(null); announceTransform(null); diagnostic("warn", "transform", "Discarded invalid empty pending transform", { documentId: document.id, layerId: pendingTransform.layerId }); return; }
      if (pendingTransform.corners) {
        // Once a transform has entered Skew/Distort/Perspective it only ever offers that quad's
        // own handles — no rotate stem, no rectangular scale handles, and no path back to them
        // within this same pending transform (see the field's own comment on why).
        const mode = (String(toolOptions["raster.move"]?.transformMode ?? "distort")) as QuadTransformMode;
        const nearest = quadHandlePoints(pendingTransform.corners, mode).find((entry) => Math.hypot(point.x - entry.point.x, point.y - entry.point.y) <= tolerance);
        if (nearest) {
          canvas.setPointerCapture(event.pointerId);
          documentGesture.current = { kind: "quad", from: point, current: point, pointerId: event.pointerId, before: pendingTransform.before, basePixels: pendingTransform.pixels.slice(), baseSelection: pendingTransform.selection ? { mask: pendingTransform.selection.mask.slice(), bounds: { ...pendingTransform.selection.bounds } } : null, sourceBounds: { ...bounds }, baseCorners: pendingTransform.corners, handleIndex: nearest.index, mode };
          return;
        }
        const xs = pendingTransform.corners.map((corner) => corner.x), ys = pendingTransform.corners.map((corner) => corner.y);
        if (point.x < Math.min(...xs) || point.x > Math.max(...xs) || point.y < Math.min(...ys) || point.y > Math.max(...ys)) { finishPendingTransform(true); return; }
        return;
      }
      if (pendingTransform.mesh && pendingTransform.meshOrigin) {
        // Warp's own handles: any of the 16 grid anchors, and nothing else — same reasoning as
        // the quad modes above, and for the same reason no rotate stem or rectangular handles.
        const pointIndex = pendingTransform.mesh.findIndex((anchor) => Math.hypot(point.x - anchor.x, point.y - anchor.y) <= tolerance);
        if (pointIndex >= 0) {
          canvas.setPointerCapture(event.pointerId);
          documentGesture.current = { kind: "warp", from: point, current: point, pointerId: event.pointerId, before: pendingTransform.before, meshOrigin: pendingTransform.meshOrigin, baseSelection: pendingTransform.selection ? { mask: pendingTransform.selection.mask.slice(), bounds: { ...pendingTransform.selection.bounds } } : null, baseMesh: pendingTransform.mesh, pointIndex };
          return;
        }
        const xs = pendingTransform.mesh.map((anchor) => anchor.x), ys = pendingTransform.mesh.map((anchor) => anchor.y);
        if (point.x < Math.min(...xs) || point.x > Math.max(...xs) || point.y < Math.min(...ys) || point.y > Math.max(...ys)) { finishPendingTransform(true); return; }
        return;
      }
      const rotatePoint = { x: bounds.x + bounds.width / 2, y: bounds.y - 27 / viewport.zoom };
      if (Math.hypot(point.x - rotatePoint.x, point.y - rotatePoint.y) <= tolerance) {
        canvas.setPointerCapture(event.pointerId); const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        documentGesture.current = { kind: "rotate", from: point, current: point, pointerId: event.pointerId, before: pendingTransform.before, basePixels: pendingTransform.text ? pendingTransform.pixels : pendingTransform.pixels.slice(), baseSelection: pendingTransform.selection ? { mask: pendingTransform.selection.mask.slice(), bounds: { ...pendingTransform.selection.bounds } } : null, sourceBounds: { ...bounds }, center, startAngle: Math.atan2(point.y - center.y, point.x - center.x), baseRotation: pendingTransform.rotation, dx: pendingTransform.dx, dy: pendingTransform.dy, ...(pendingTransform.text ? { text: pendingTransform.text } : {}) };
        return;
      }
      const handles = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]] as const;
      const handle = handles.find(([x, y]) => Math.hypot(point.x - (bounds.x + (x + 1) * bounds.width / 2), point.y - (bounds.y + (y + 1) * bounds.height / 2)) <= tolerance);
      if (handle) {
        canvas.setPointerCapture(event.pointerId);
        documentGesture.current = { kind: "scale", from: point, current: point, pointerId: event.pointerId, before: pendingTransform.before, basePixels: pendingTransform.text ? pendingTransform.pixels : pendingTransform.pixels.slice(), baseSelection: pendingTransform.selection ? { mask: pendingTransform.selection.mask.slice(), bounds: { ...pendingTransform.selection.bounds } } : null, sourceBounds: { ...bounds }, handleX: handle[0], handleY: handle[1], dx: pendingTransform.dx, dy: pendingTransform.dy, ...(pendingTransform.text ? { text: pendingTransform.text } : {}) };
        return;
      }
      // Clicking away from the frame accepts the transform, the way it does in
      // Photoshop. Only Escape and the bar's cross reject it. Without this the
      // frame stayed behind after the click and the next gesture was applied on
      // top of a transform that had never been committed.
      if (point.x < bounds.x || point.y < bounds.y || point.x > bounds.x + bounds.width || point.y > bounds.y + bounds.height) {
        finishPendingTransform(true);
        return;
      }
    }
    // Locks are checked once, here, rather than in each tool: every tool below
    // this point either paints or moves, and a refusal has to be visible or the
    // user is left wondering why the canvas stopped responding.
    if (!maskTarget && activeToolId) {
      const action = activeToolId === "raster.move" || activeToolId === "raster.crop" ? "move" : activeToolId === "raster.eraser" ? "erase" : "paint";
      if (!layerAccepts(layer, action)) {
        diagnostic("info", "layer.locked", layerLockReason(layer, action) ?? "Layer is locked", { documentId: document.id, layerId: layer.id, tool: activeToolId });
        return;
      }
    }
    if (!maskTarget && activeToolId && layer.kind !== "pixel" && RASTER_ONLY_TOOLS.has(activeToolId)) {
      setRasterizeConfirm({ layerId: layer.id, layerName: layer.name });
      return;
    }
    if (activeToolId === "raster.crop" || activeToolId === "raster.move") {
      const effectiveSelection = activeToolId === "raster.move" && state.selection ? restrictSelectionToAlpha(state.selection, canvasPixels(layer), state.width, state.height) : null;
      if (activeToolId === "raster.move" && state.selection && !effectiveSelection) { diagnostic("info", "move", "Move ignored: selection contains no opaque pixels", { documentId: document.id, layerId: layer.id }); return; }
      if (activeToolId === "raster.move" && !state.selection && !(layer.kind === "text" && layer.text?.visualBounds?.width ? layer.text.visualBounds : alphaBounds(canvasPixels(layer), state.width, state.height))) { diagnostic("info", "move", "Move ignored: layer is empty", { documentId: document.id, layerId: layer.id }); return; }
      canvas.setPointerCapture(event.pointerId);
      let pending = activeToolId === "raster.move" ? pendingTransformRef.current : null, createdTextTransform = false;
      if (activeToolId === "raster.move" && !pending && layer.kind === "text" && layer.text && !effectiveSelection) {
        const bounds = layer.text.visualBounds?.width ? layer.text.visualBounds : alphaBounds(canvasPixels(layer), state.width, state.height)!;
        pending = { before: state, layerId: layer.id, dx: 0, dy: 0, pixels: canvasPixels(layer), selection: null, rotation: 0, text: { original: structuredClone(layer.text), initialBounds: { ...bounds }, targetBounds: { ...bounds } } };
        pendingTransformRef.current = pending; setTransformPreview(pending); announceTransform(pending);
        createdTextTransform = true;
      }
      // Every drag of a pending move recomputes from the pixels the transform
      // started with, by the running total offset — never from the previous
      // drag's result. Cutting the selection out of an image it has already been
      // cut out of leaves a second hole, and with a feathered edge a second
      // ring, once per drag, none of which was ever committed.
      const origin = pending && !pending.text ? pending.before.layers.find((item) => item.id === pending.layerId) : null;
      const originSelection = origin ? restrictSelectionToAlpha(pending!.before.selection ?? null, canvasPixels(origin), state.width, state.height) : null;
      // The content is lifted off the layer once and then placed, never cut
      // again. Cutting per frame is what left a fraction of a soft edge behind
      // at every position the pointer passed through.
      const float = activeToolId === "raster.move" && !pending?.text
        ? pending?.float ?? liftSelection(origin ? canvasPixels(origin) : canvasPixels(layer), state.width, state.height, origin ? originSelection : effectiveSelection)
        : undefined;
      documentGesture.current = { kind: activeToolId === "raster.crop" ? "crop" : "move", from: point, current: point, pointerId: event.pointerId, before: pending?.before ?? cloneRasterState(gestureState), startDx: pending?.dx ?? 0, startDy: pending?.dy ?? 0, basePixels: origin ? canvasPixels(origin).slice() : pending ? (pending.text ? pending.pixels : pending.pixels.slice()) : canvasPixels(layer).slice(), baseSelection: origin ? (originSelection ? { mask: originSelection.mask.slice(), bounds: { ...originSelection.bounds } } : null) : pending?.selection ? { mask: pending.selection.mask.slice(), bounds: { ...pending.selection.bounds } } : effectiveSelection ? { mask: effectiveSelection.mask.slice(), bounds: { ...effectiveSelection.bounds } } : null, rotation: pending?.rotation ?? 0, ...(pending?.text ? { text: pending.text } : {}), ...(createdTextTransform ? { createdTextTransform: true } : {}), ...(origin ? { fromOrigin: true } : {}), ...(float ? { float } : {}) };
      setSelectionDraft(activeToolId === "raster.crop" ? { x: point.x, y: point.y, width: 0, height: 0 } : null);
      return;
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (catalogueTool?.onPointerMove) {
      const workspace = workspaceRef.current;
      if (workspace) {
        const rect = workspace.getBoundingClientRect();
        const context = toolContextFor(catalogueTool.id, event.currentTarget);
        // Coalesced samples, not just the one event React handed over: a
        // fast stroke can move the pointer several pixels between the
        // browser's own paint frames, and using only the latest sample is
        // what RASTER-PAINT-002 already found leaves gaps in a fast stroke.
        // The context is built once and reused across all of them — its
        // closures do not depend on which sample is current, only `pointer`
        // does, and toolContextFor is not free to call per sample.
        for (const native of event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]) {
          catalogueTool.onPointerMove(context, toolPointerFromNative(native, workspace, rect));
        }
      }
      return;
    }
    const transforming = documentGesture.current;
    if (transforming && transforming.pointerId === event.pointerId) {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const point = pointFromNativeEvent(workspace, viewport, state.width, state.height, event.nativeEvent);
      transforming.current = point;
      if (transforming.kind === "crop") { setSelectionDraft({ x: Math.min(transforming.from.x, point.x), y: Math.min(transforming.from.y, point.y), width: Math.abs(point.x - transforming.from.x), height: Math.abs(point.y - transforming.from.y) }); return; }
      // The scale/rotate/move branches recompute a full-canvas pixel buffer (O(width*height)).
      // Native pointermove can fire far faster than the browser can repaint, so doing that work
      // synchronously on every event backs up the main thread and reads as a total freeze while
      // dragging. Coalesce to one recompute per animation frame, like the brush path already does.
      scheduleTransformFrame(transforming);
      return;
    }
  };

  const finishGesture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (catalogueTool?.onGestureEnd) {
      const pointer = toolPointerFrom(event);
      if (pointer) { catalogueTool.onGestureEnd(toolContextFor(catalogueTool.id, event.currentTarget), pointer); return; }
    }
    const transforming = documentGesture.current;
    if (transforming && transforming.pointerId === event.pointerId) {
      if (transformFrameRef.current !== null) { cancelAnimationFrame(transformFrameRef.current); transformFrameRef.current = null; }
      documentGesture.current = null;
      setSelectionDraft(null);
      if (transforming.kind === "scale" || transforming.kind === "rotate" || transforming.kind === "quad" || transforming.kind === "warp") { applyTransformFrame(transforming); return; }
      const dx = transforming.startDx + transforming.current.x - transforming.from.x, dy = transforming.startDy + transforming.current.y - transforming.from.y;
      if (transforming.kind === "move") {
        const deltaX = transforming.current.x - transforming.from.x, deltaY = transforming.current.y - transforming.from.y;
        if (Math.hypot(deltaX, deltaY) < .25) { if (transforming.createdTextTransform) { pendingTransformRef.current = null; setTransformPreview(null); announceTransform(null); } const canvas = canvasRef.current; if (canvas) putPixels(canvas, compositeRasterDocument(state), state.width, state.height); return; }
        if (transforming.text) { applyTransformFrame(transforming); return; }
        // The same arithmetic the live frames use. This path had its own copy
        // that cut from the original by this drag's delta alone, so releasing
        // the button threw away the correct preview and replaced it with one
        // that had lost every earlier drag.
        const shiftX = transforming.float || transforming.fromOrigin ? dx : deltaX;
        const shiftY = transforming.float || transforming.fromOrigin ? dy : deltaY;
        const pixels = transforming.float
          ? stampFloating(transforming.float, state.width, state.height, shiftX, shiftY)
          : translateLayerPixels(transforming.basePixels, state.width, state.height, shiftX, shiftY, transforming.baseSelection);
        const preview = { before: transforming.before, layerId: transforming.before.activeLayerId, dx, dy, pixels, selection: translateSelection(transforming.baseSelection, state.width, state.height, shiftX, shiftY), rotation: transforming.rotation, ...(transforming.float ? { float: transforming.float } : {}) };
        pendingTransformRef.current = preview;
        setTransformPreview(preview);
        announceTransform(preview);
        renderWorking(pixels);
      } else {
        const rect = { x: Math.min(transforming.from.x, transforming.current.x), y: Math.min(transforming.from.y, transforming.current.y), width: Math.abs(dx), height: Math.abs(dy) };
        if (rect.width >= 1 && rect.height >= 1) { void commitDocumentState(transforming.before, cropRasterDocument(transforming.before, rect), "Crop (Кадрирование)"); setViewport(document.id, { mode: "fit", panX: 0, panY: 0 }); }
      }
      return;
    }
  };

  const selectionRect = selectionDraft;
  const stageStyle = { width: state.width, height: state.height, transform: `translate(-50%, -50%) translate(${viewport.panX}px, ${viewport.panY}px) rotate(${viewport.rotation}deg) scale(${viewport.zoom})` } as CSSProperties;
  const beginNavigation = (event: React.PointerEvent<HTMLDivElement>) => {
    const temporaryHand = (spaceHeld && !spaceZoom) || event.button === 1;
    const kind = spaceZoom ? "zoom" : temporaryHand || activeToolId === "raster.hand" ? "pan" : activeToolId === "raster.rotateView" ? "rotate" : activeToolId === "raster.zoom" ? "zoom" : null;
    if (!kind) return;
    event.preventDefault(); event.stopPropagation();
    const scrubbyZoom = Boolean(toolOptions["raster.zoom"]?.dragZoom ?? useShellStore.getState().preferences.dragZoom);
    if (kind === "zoom" && (spaceZoom || !scrubbyZoom)) {
      const workspace = workspaceRef.current;
      if (workspace) {
        const out = spaceZoom === "out" || (!spaceZoom && event.altKey);
        const zoom = clampZoom(viewport.zoom * (out ? 0.8 : 1.25));
        setViewport(document.id, zoomAroundClient(workspace, viewport, zoom, event.clientX, event.clientY));
      }
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    navigationGesture.current = { kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, initial: { ...viewport }, alt: event.altKey, moved: false };
    setNavigating(true);
  };
  const moveNavigation = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = navigationGesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const dx = event.clientX - current.startX, dy = event.clientY - current.startY;
    current.moved ||= Math.hypot(dx, dy) > 3;
    if (current.kind === "pan") setViewport(document.id, { panX: current.initial.panX + dx, panY: current.initial.panY + dy, mode: "custom" });
    else if (current.kind === "rotate") {
      const raw = current.initial.rotation + dx * 0.3;
      setViewport(document.id, { rotation: event.shiftKey ? Math.round(raw / 15) * 15 : raw, mode: "custom" });
    } else {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const zoom = clampZoom(current.initial.zoom * Math.exp(dx * 0.01));
      setViewport(document.id, zoomAroundClient(workspace, current.initial, zoom, current.startX, current.startY));
    }
  };
  const endNavigation = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = navigationGesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (current.kind === "zoom" && !current.moved) {
      const workspace = workspaceRef.current;
      if (workspace) {
        const zoom = clampZoom(current.initial.zoom * (current.alt ? 0.8 : 1.25));
        setViewport(document.id, zoomAroundClient(workspace, current.initial, zoom, event.clientX, event.clientY));
      }
    }
    navigationGesture.current = null;
    setNavigating(false);
  };
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || event.altKey) {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const zoom = clampZoom(viewport.zoom * Math.exp(-event.deltaY * 0.002));
      setViewport(document.id, zoomAroundClient(workspace, viewport, zoom, event.clientX, event.clientY));
    } else setViewport(document.id, { panX: viewport.panX - (event.shiftKey ? event.deltaY : event.deltaX), panY: viewport.panY - (event.shiftKey ? 0 : event.deltaY), mode: "custom" });
  };
  // A drag-in-progress preview from the catalogue's marquee/ellipse/lasso
  // tools (moving an existing selection), read out of tool state the same
  // way their own Overlay is — this used to be a piece of RasterWorkspace's
  // own state (`marqueePreview`) written directly by the pointer handlers;
  // now that those three tools own that gesture, the preview lives in their
  // state instead, and the host just reads it to keep drawing marching ants
  // during the drag rather than duplicating that rendering per tool.
  const catalogueMarqueePreview = activeToolId
    ? (toolStates[activeToolId] as { drag?: { preview: PixelSelection | null } } | undefined)?.drag?.preview ?? null
    : null;
  const displayedSelection = catalogueMarqueePreview ?? transformPreview?.selection ?? state.selection;
  // The Move tool's "Transform controls" checkbox: with it off there is no frame
  // and no handles, which is how Photoshop lets you drag without the furniture.
  const showTransformControls = toolOptions["raster.move"]?.showTransform !== false;
  const transformBounds = transformPreview && showTransformControls ? (transformPreview.text?.targetBounds ?? displayedSelection?.bounds ?? alphaBounds(transformPreview.pixels, state.width, state.height)) : null;
  // Cmd/Ctrl+H hides the marching ants without dropping the selection, so an
  // edge can be judged without the animation crawling over it.
  const committedSelectionPath = displayedSelection && !selectionEdgesHidden ? selectionOutlinePath(displayedSelection.mask, state.width, state.height) : "";
  const brushLike = activeToolId === "raster.brush" || activeToolId === "raster.pencil" || activeToolId === "raster.highlighter" || activeToolId === "raster.eraser" || activeToolId === "raster.clone" || activeToolId === "raster.spotHeal" || activeToolId === "raster.blur" || activeToolId === "raster.smudge" || activeToolId === "raster.dodge" || activeToolId === "raster.burn";
  const selectionLike = activeToolId === "raster.marquee" || activeToolId === "raster.ellipseMarquee" || activeToolId === "raster.lasso";
  const selectionContextMenu = useContextMenu();
  const transformContextMenu = useContextMenu();
  const onSelectionContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (!selectionLike || !activeToolId) return;
    const currentMode = String(toolOptions[activeToolId]?.mode ?? "replace");
    const modes: { value: SelectionCombineMode; english: string; russian: string }[] = [
      { value: "replace", english: "Replace Selection", russian: "Заменить выделение" },
      { value: "add", english: "Add to Selection", russian: "Добавить к выделению" },
      { value: "subtract", english: "Subtract from Selection", russian: "Вычесть из выделения" },
      { value: "intersect", english: "Intersect with Selection", russian: "Пересечь с выделением" },
    ];
    selectionContextMenu.open(event, modes.map((entry) => ({
      label: (currentMode === entry.value ? "✓ " : "") + text(language, entry.english, entry.russian),
      onSelect: () => setToolOption(activeToolId, "mode", entry.value),
    })));
  };
  // The transform tool's own right-click menu: Photoshop's Edit > Transform submodes, offered
  // only once a Free Transform is actually active on a pixel layer (a text transform stays on
  // the rectangular path — quad-warping live text has no defined meaning here).
  const onTransformContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const pending = pendingTransformRef.current;
    if (activeToolId !== "raster.move" || !pending || pending.text) return;
    const bounds = pending.selection?.bounds ?? alphaBounds(pending.pixels, state.width, state.height);
    if (!bounds) return;
    const currentMode = pending.corners ? String(toolOptions["raster.move"]?.transformMode ?? "distort") : pending.mesh ? "warp" : "free";
    const enterQuadMode = (mode: QuadTransformMode) => {
      setToolOption("raster.move", "transformMode", mode);
      if (!pending.corners) {
        const corners: [Point, Point, Point, Point] = [{ x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height }];
        const next: PendingPixelTransform = { ...pending, corners };
        pendingTransformRef.current = next; setTransformPreview(next); announceTransform(next);
      }
    };
    const enterWarp = () => {
      if (pending.mesh) return;
      const meshOrigin = { pixels: pending.pixels.slice(), bounds: { ...bounds } };
      const mesh = regularMesh(bounds, WARP_GRID);
      const next: PendingPixelTransform = { ...pending, mesh, meshOrigin };
      pendingTransformRef.current = next; setTransformPreview(next); announceTransform(next);
    };
    const modes: { value: QuadTransformMode; english: string; russian: string }[] = [
      { value: "skew", english: "Skew", russian: "Наклон" },
      { value: "distort", english: "Distort", russian: "Искажение" },
      { value: "perspective", english: "Perspective", russian: "Перспектива" },
    ];
    transformContextMenu.open(event, [
      ...modes.map((entry) => ({
        label: (currentMode === entry.value ? "✓ " : "") + text(language, entry.english, entry.russian),
        onSelect: () => enterQuadMode(entry.value),
      })),
      { label: (currentMode === "warp" ? "✓ " : "") + text(language, "Warp", "Деформация"), onSelect: enterWarp, separatorBefore: true },
    ]);
  };
  const brushOptions = toolOptions[activeToolId ?? ""] ?? {};
  const tipAngle = Number(brushOptions.angle ?? 0), tipRoundness = Number(brushOptions.roundness ?? 100);
  const tipRadians = tipAngle * Math.PI / 180, tipShortRadius = 48 * tipRoundness / 100;
  const roundnessHandle = { x: 60 - Math.sin(tipRadians) * tipShortRadius, y: 60 + Math.cos(tipRadians) * tipShortRadius };
  const updateTipGeometry = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!tipDragMode.current || !activeToolId) return;
    const rect = event.currentTarget.getBoundingClientRect(), x = (event.clientX - rect.left) * 120 / rect.width - 60, y = (event.clientY - rect.top) * 120 / rect.height - 60;
    if (tipDragMode.current === "angle") setToolOption(activeToolId, "angle", Math.round(Math.atan2(y, x) * 180 / Math.PI));
    else { const perpendicular = Math.abs(-Math.sin(tipRadians) * x + Math.cos(tipRadians) * y); setToolOption(activeToolId, "roundness", Math.max(5, Math.min(100, Math.round(perpendicular / 48 * 100)))); }
  };
  const updateBrushCursor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!brushLike || !workspaceRef.current || !brushCursorRef.current) return;
    // Screen pixels, not document ones: the cursor is interface, drawn in a layer
    // that sits outside .raster-stage's zoom transform, so a plain client-relative
    // position is already correct — no inverse-zoom math needed to place it.
    const rect = workspaceRef.current.getBoundingClientRect();
    const screenX = event.clientX - rect.left, screenY = event.clientY - rect.top;
    brushCursorRef.current.style.transform = `translate(${screenX}px, ${screenY}px) rotate(${tipAngle}deg)`;
    brushCursorRef.current.style.opacity = "1";
    if (activeToolId === "raster.clone") {
      const point = pointFromNativeEvent(workspaceRef.current, viewport, state.width, state.height, event.nativeEvent);
      updateCloneSourceView(point);
      const preview = cloneSourceCanvasRef.current;
      if (preview) {
        // Anchored on the pointer itself, so it sits inside the brush ring
        // rather than beside it. The ring is drawn on the same centre.
        preview.style.left = `${screenX}px`;
        preview.style.top = `${screenY}px`;
      }
    }
  };

  /**
   * Shows where the clone stamp is reading from, and what it is about to lay down.
   *
   * Without it the tool is guesswork: the source is invisible, so the only way
   * to find out what a stroke will produce is to make it and undo. Photoshop
   * answers both questions on the canvas — a crosshair at the source, and the
   * sampled area previewed inside the brush tip.
   */
  const updateCloneSourceView = (point: Point) => {
    const anchor = sourcePointRef.current;
    if (!anchor) { setCloneSourceView(null); return; }
    const offset = cloneOffsetRef.current ?? { x: anchor.x - point.x, y: anchor.y - point.y };
    const source = { x: point.x + offset.x, y: point.y + offset.y };
    setCloneSourceView(source);

    const preview = cloneSourceCanvasRef.current;
    if (!preview) return;
    const size = Math.max(2, Math.round(Number(toolOptions["raster.clone"]?.size ?? 24)));
    if (preview.width !== size) { preview.width = size; preview.height = size; }
    const context = preview.getContext("2d");
    const layer = state.layers.find((item) => item.id === state.activeLayerId);
    if (!context || !layer) return;
    context.clearRect(0, 0, size, size);
    const sampled = canvasPixels(layer);
    // Read straight out of the layer buffer: the sample is what the tool will
    // actually copy, not what the composite happens to show over it.
    const image = context.createImageData(size, size);
    const half = size / 2;
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const sourceX = Math.round(source.x - half + x), sourceY = Math.round(source.y - half + y);
      if (sourceX < 0 || sourceY < 0 || sourceX >= state.width || sourceY >= state.height) continue;
      const from = (sourceY * state.width + sourceX) * 4, to = (y * size + x) * 4;
      image.data[to] = sampled[from]!; image.data[to + 1] = sampled[from + 1]!;
      image.data[to + 2] = sampled[from + 2]!; image.data[to + 3] = sampled[from + 3]!;
    }
    context.putImageData(image, 0, 0);

    // The tip's own falloff, applied to the preview. A soft stamp does not lay
    // down a disc with a hard edge, and a preview that shows one promises an
    // edge the stroke will not produce.
    const hardness = Math.max(0, Math.min(1, Number(toolOptions["raster.clone"]?.hardness ?? 82) / 100));
    context.globalCompositeOperation = "destination-in";
    const centre = size / 2;
    const falloff = context.createRadialGradient(centre, centre, centre * hardness, centre, centre, centre);
    falloff.addColorStop(0, "rgba(0,0,0,1)");
    falloff.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = falloff;
    context.fillRect(0, 0, size, size);
    context.globalCompositeOperation = "source-over";
  };
  const guidePointer = (event: React.PointerEvent<HTMLDivElement>, orientation: RasterGuide["orientation"], finish = false) => {
    const workspace = workspaceRef.current; if (!workspace) return;
    const point = pointFromNativeEvent(workspace, viewport, state.width, state.height, event.nativeEvent), position = orientation === "vertical" ? point.x : point.y;
    const next = { orientation, position } satisfies RasterGuide;
    if (!finish) { event.currentTarget.setPointerCapture(event.pointerId); setGuideDraft(next); return; }
    setGuideDraft(null);
    const limit = orientation === "vertical" ? state.width : state.height;
    if (position < 0 || position > limit) return;
    kernel.documents.update<RasterDocumentState>(document.id, (current) => { (current.guides ??= []).push(next); });
  };
  const step = rulerStep(viewport.zoom), documentOriginX = workspaceSize.width / 2 + viewport.panX - state.width * viewport.zoom / 2, documentOriginY = workspaceSize.height / 2 + viewport.panY - state.height * viewport.zoom / 2;
  const horizontalTicks: number[] = [], verticalTicks: number[] = [];
  for (let value = Math.floor(-documentOriginX / (step * viewport.zoom)) * step; value * viewport.zoom + documentOriginX < workspaceSize.width; value += step) horizontalTicks.push(value);
  for (let value = Math.floor(-documentOriginY / (step * viewport.zoom)) * step; value * viewport.zoom + documentOriginY < workspaceSize.height; value += step) verticalTicks.push(value);
  const guides = state.guides ?? [];
  const onDropModel = (event: React.DragEvent<HTMLDivElement>) => {
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => /\.(obj|glb|gltf)$/i.test(file.name));
    if (!files.length) return;
    event.preventDefault();
    files.forEach((file) => void importModelAsLayer(document.id, file));
  };

  return <div ref={workspaceRef} className="raster-workspace" data-active-tool={activeToolId} data-pixel-zoom={viewport.zoom >= 1 || undefined} data-space-held={spaceHeld || undefined} data-navigating={navigating || undefined} onPointerDownCapture={beginNavigation} onPointerMoveCapture={moveNavigation} onPointerUpCapture={endNavigation} onPointerCancelCapture={endNavigation} onWheel={handleWheel} onDragOver={(event) => { if ([...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={onDropModel}>
    <div className="raster-stage" style={stageStyle}>
      <canvas ref={canvasRef} className={brushLike ? "brush-cursor-canvas" : ""} width={state.width} height={state.height} onPointerEnter={updateBrushCursor} onPointerLeave={() => { if (brushCursorRef.current) brushCursorRef.current.style.opacity = "0"; setCloneSourceView(null); }} onPointerDown={handlePointerDown} onPointerMove={(event) => { updateBrushCursor(event); handlePointerMove(event); }} onPointerUp={finishGesture} onPointerCancel={finishGesture} onContextMenu={(event) => { if (selectionLike) { onSelectionContextMenu(event); return; } if (activeToolId === "raster.move" && pendingTransformRef.current) { onTransformContextMenu(event); return; } event.preventDefault(); if (!brushLike) return; const rect = workspaceRef.current?.getBoundingClientRect(); if (rect) setBrushPopup({ left: Math.min(event.clientX - rect.left, rect.width - 300), top: Math.min(event.clientY - rect.top, rect.height - 430), detailed: false }); }} />
      {transformPreview?.text && <canvas
        ref={textTransformCanvasRef}
        className="text-transform-preview"
        style={{ left: transformPreview.text.targetBounds.x, top: transformPreview.text.targetBounds.y, width: transformPreview.text.targetBounds.width, height: transformPreview.text.targetBounds.height, transform: `rotate(${transformPreview.rotation}deg)` }}
      />}
      {preferences.showGuides && <svg className="guide-overlay" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true">{[...guides, ...(guideDraft ? [guideDraft] : [])].map((guide, index) => guide.orientation === "vertical" ? <line key={`${guide.orientation}-${index}`} x1={guide.position} y1="0" x2={guide.position} y2={state.height}/> : <line key={`${guide.orientation}-${index}`} x1="0" y1={guide.position} x2={state.width} y2={guide.position}/>)}</svg>}
      {/* Whatever the active catalogue tool draws over the canvas. */}
      {catalogueTool?.Overlay && <catalogueTool.Overlay state={toolStates[catalogueTool.id] ?? catalogueTool.createState()} document={state} options={(toolOptions[catalogueTool.id] ?? {}) as Readonly<Record<string, string | number | boolean>>} context={toolContextFor(catalogueTool.id, canvasRef.current)}/>}
      {/* raster.crop is the only tool left drawing through selectionDraft —
          marquee/ellipseMarquee/lasso/patch each draw their own preview
          through their own catalogue Overlay now. */}
      {selectionRect && selectionRect.width > 0 && selectionRect.height > 0 && <svg className="selection-overlay" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true">
        <rect x={selectionRect.x} y={selectionRect.y} width={selectionRect.width} height={selectionRect.height}/>
      </svg>}
      {!selectionDraft && committedSelectionPath && <svg className="selection-overlay committed-selection" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><path className="selection-soft-edge" d={committedSelectionPath} /><path className="selection-hard-edge" d={committedSelectionPath} /></svg>}
      {transformPreview && transformPreview.corners && <svg className="transform-controls" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true">
        <polygon className="transform-quad-outline" points={transformPreview.corners.map((corner) => `${corner.x},${corner.y}`).join(" ")}/>
        {quadHandlePoints(transformPreview.corners, String(toolOptions["raster.move"]?.transformMode ?? "distort") as QuadTransformMode).map(({ index, point }) => <rect className="transform-handle" key={index} x={point.x - 4 / viewport.zoom} y={point.y - 4 / viewport.zoom} width={8 / viewport.zoom} height={8 / viewport.zoom}/>)}
      </svg>}
      {transformPreview && transformPreview.mesh && <svg className="transform-controls" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true">
        {Array.from({ length: WARP_GRID + 1 }, (_, row) => <polyline key={`row-${row}`} className="transform-quad-outline" points={transformPreview.mesh!.slice(row * (WARP_GRID + 1), row * (WARP_GRID + 1) + WARP_GRID + 1).map((anchor) => `${anchor.x},${anchor.y}`).join(" ")}/>)}
        {Array.from({ length: WARP_GRID + 1 }, (_, col) => <polyline key={`col-${col}`} className="transform-quad-outline" points={Array.from({ length: WARP_GRID + 1 }, (_, row) => transformPreview.mesh![row * (WARP_GRID + 1) + col]!).map((anchor) => `${anchor.x},${anchor.y}`).join(" ")}/>)}
        {transformPreview.mesh.map((anchor, index) => <rect className="transform-handle" key={index} x={anchor.x - 4 / viewport.zoom} y={anchor.y - 4 / viewport.zoom} width={8 / viewport.zoom} height={8 / viewport.zoom}/>)}
      </svg>}
      {transformPreview && !transformPreview.corners && !transformPreview.mesh && transformBounds && <svg className="transform-controls" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><rect x={transformBounds.x} y={transformBounds.y} width={transformBounds.width} height={transformBounds.height}/><line className="transform-rotation-stem" x1={transformBounds.x + transformBounds.width / 2} y1={transformBounds.y} x2={transformBounds.x + transformBounds.width / 2} y2={transformBounds.y - 27 / viewport.zoom}/><circle className="transform-rotation-handle" cx={transformBounds.x + transformBounds.width / 2} cy={transformBounds.y - 27 / viewport.zoom} r={5 / viewport.zoom}/>{([[0,0],[.5,0],[1,0],[0,.5],[1,.5],[0,1],[.5,1],[1,1]] as [number, number][]).map(([x,y], index) => <rect className="transform-handle" key={index} x={transformBounds.x + transformBounds.width * x - 4 / viewport.zoom} y={transformBounds.y + transformBounds.height * y - 4 / viewport.zoom} width={8 / viewport.zoom} height={8 / viewport.zoom}/>)}</svg>}
    </div>
    {/*
      Cursors live outside .raster-stage on purpose: that element carries the zoom's CSS scale
      transform, and vector-effect:non-scaling-stroke does not reliably cancel a *CSS* transform
      on an ancestor the way it cancels an SVG viewBox/internal transform — the ring's outline
      was measurably scaling with zoom despite asking it not to. Positioned here, in an
      unscaled sibling layer, a ring's diameter is set directly in screen pixels (so it still
      shows the tool's true footprint at the current zoom) while its border is a literal CSS
      pixel value untouched by any transform — the interface, unlike the document, does not
      grow with the zoom. Same reasoning documentOriginX/Y already use for the rulers.
    */}
    {brushLike && <div ref={brushCursorRef} className="brush-cursor" style={{ opacity: 0 }}>
      {preciseCursor
        ? <span className="cursor-crosshair"/>
        : <span className="cursor-ring" style={{ width: Number(brushOptions.size ?? 24) * viewport.zoom, height: Number(brushOptions.size ?? 24) * viewport.zoom * tipRoundness / 100 }}/>}
    </div>}
    {activeToolId === "raster.clone" && (
      <>
        {/* The sample, shown inside the tip: what the next dab will lay down,
            clipped to a circle so it reads as the brush rather than a swatch. */}
        <canvas ref={cloneSourceCanvasRef} className="clone-source-preview" width={2} height={2} aria-hidden="true"
          style={cloneSourceView ? {
            width: `${Number(toolOptions["raster.clone"]?.size ?? 24) * viewport.zoom}px`,
            height: `${Number(toolOptions["raster.clone"]?.size ?? 24) * viewport.zoom}px`,
          } : { opacity: 0 }}/>
        {cloneSourceView && <div className="clone-source-cursor" style={{
          left: documentOriginX + cloneSourceView.x * viewport.zoom,
          top: documentOriginY + cloneSourceView.y * viewport.zoom,
          width: Number(toolOptions["raster.clone"]?.size ?? 24) * viewport.zoom,
          height: Number(toolOptions["raster.clone"]?.size ?? 24) * viewport.zoom,
        }}>
          <span className="cursor-ring"/>
          <span className="cursor-crosshair"/>
        </div>}
      </>
    )}
    {preferences.showRulers && <div className="rulers" aria-hidden="true"><div className="ruler-corner"/><div className="ruler-horizontal" onPointerDown={(event) => guidePointer(event, "horizontal")} onPointerMove={(event) => { if (guideDraft?.orientation === "horizontal") guidePointer(event, "horizontal"); }} onPointerUp={(event) => guidePointer(event, "horizontal", true)}>{horizontalTicks.map((value) => <i key={value} style={{ left: value * viewport.zoom + documentOriginX }}><span>{Math.round(value)}</span></i>)}</div><div className="ruler-vertical" onPointerDown={(event) => guidePointer(event, "vertical")} onPointerMove={(event) => { if (guideDraft?.orientation === "vertical") guidePointer(event, "vertical"); }} onPointerUp={(event) => guidePointer(event, "vertical", true)}>{verticalTicks.map((value) => <i key={value} style={{ top: value * viewport.zoom + documentOriginY }}><span>{Math.round(value)}</span></i>)}</div></div>}
    {brushPopup && brushLike && <aside className="brush-popup" style={{ left: Math.max(6, brushPopup.left), top: Math.max(6, brushPopup.top) }} onContextMenu={(event) => event.preventDefault()}>
      <header><strong>Brush Tip (Отпечаток кисти)</strong><button onClick={() => setBrushPopup(null)}>×</button></header>
      <div className="brush-tip-editor"><svg viewBox="0 0 120 120" onPointerMove={updateTipGeometry} onPointerUp={() => { tipDragMode.current = null; }} onPointerCancel={() => { tipDragMode.current = null; }}>
        <circle cx="60" cy="60" r="49" className="tip-guide"/><ellipse cx="60" cy="60" rx="48" ry={tipShortRadius} transform={`rotate(${tipAngle} 60 60)`} className="tip-shape"/>
        <line x1="60" y1="60" x2={60 + Math.cos(tipRadians) * 48} y2={60 + Math.sin(tipRadians) * 48} className="tip-angle-line"/>
        <circle cx={60 + Math.cos(tipRadians) * 48} cy={60 + Math.sin(tipRadians) * 48} r="5" className="tip-handle" onPointerDown={(event) => { tipDragMode.current = "angle"; event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); }}/>
        <circle cx={roundnessHandle.x} cy={roundnessHandle.y} r="5" className="tip-handle" onPointerDown={(event) => { tipDragMode.current = "roundness"; event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); }}/>
      </svg><div><label>Size (Размер)<input type="number" min="1" max="1000" value={Number(brushOptions.size ?? 24)} onChange={(event) => setToolOption(activeToolId!, "size", event.target.valueAsNumber)}/></label><label>Hardness (Жёсткость)<input type="range" min="0" max="100" value={Number(brushOptions.hardness ?? 82)} onChange={(event) => setToolOption(activeToolId!, "hardness", event.target.valueAsNumber)}/></label><small>{tipAngle}° · {tipRoundness}%</small></div></div>
      <div className="brush-presets"><button onClick={() => { setToolOption(activeToolId!, "hardness", 100); setToolOption(activeToolId!, "roundness", 100); }}>●<small>Hard Round (Жёсткая круглая)</small></button><button onClick={() => { setToolOption(activeToolId!, "hardness", 0); setToolOption(activeToolId!, "roundness", 100); }}>◉<small>Soft Round (Мягкая круглая)</small></button><button onClick={() => { setToolOption(activeToolId!, "hardness", 100); setToolOption(activeToolId!, "roundness", 22); setToolOption(activeToolId!, "angle", -25); }}>▬<small>Calligraphy (Каллиграфия)</small></button></div>
      <button className="brush-details-toggle" onClick={() => setBrushPopup({ ...brushPopup, detailed: !brushPopup.detailed })}>{brushPopup.detailed ? "Hide Brush Settings (Скрыть настройки)" : "Brush Settings… (Настройки кисти…)"}</button>
      {brushPopup.detailed && <div className="brush-detail-fields"><label>Spacing (Интервал)<input type="range" min="1" max="300" value={Number(brushOptions.spacing ?? 12)} onChange={(event) => setToolOption(activeToolId!, "spacing", event.target.valueAsNumber)}/><span>{Number(brushOptions.spacing ?? 12)}%</span></label><label>Roundness (Округлость)<input type="range" min="5" max="100" value={tipRoundness} onChange={(event) => setToolOption(activeToolId!, "roundness", event.target.valueAsNumber)}/><span>{tipRoundness}%</span></label><label>Angle (Угол)<input type="range" min="-180" max="180" value={tipAngle} onChange={(event) => setToolOption(activeToolId!, "angle", event.target.valueAsNumber)}/><span>{tipAngle}°</span></label></div>}
    </aside>}
    {transformPreview && <div className="pending-transform-hint">Enter — Apply (Применить) · Esc — Cancel (Отменить)</div>}
    <div className="canvas-badge">{state.width} × {state.height} · {Math.round(viewport.zoom * 100)}% · {Math.round(viewport.rotation * 10) / 10}° · sRGB · {state.layers.length} layer(s)</div>
    {rasterizeConfirm && <div className="dialog-backdrop rasterize-confirm-backdrop" onMouseDown={() => setRasterizeConfirm(null)}>
      <section className="rasterize-confirm" role="alertdialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <strong>{localized("This tool needs pixels (Этому инструменту нужны пиксели)", language)}</strong>
        <p>{localized(`"${rasterizeConfirm.layerName}" is a text layer and has no pixels to edit yet. Rasterize it into a normal pixel layer first? (Слой «${rasterizeConfirm.layerName}» — текстовый, у него ещё нет пикселей для редактирования. Растрировать его в обычный слой с пикселями?)`, language)}</p>
        <footer>
          <button onClick={() => setRasterizeConfirm(null)}>{localized("Cancel (Отмена)", language)}</button>
          <button className="primary" onClick={confirmRasterize}>{localized("Rasterize Layer (Растрировать слой)", language)}</button>
        </footer>
      </section>
    </div>}
    {selectionContextMenu.node}
    {transformContextMenu.node}
  </div>;
}
