import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  activeRasterLayer, appendLayer, clampRegionToDocument, layerAccepts, layerLockReason, layerOpaqueBounds, paintMask, marqueeCorners, marqueeRect, pickLayerAt, combineSelections, compositeRasterDocument, compositeRasterRegion, createContiguousColorSelection, drawShape, DirtyRegion, RasterTileCache, type ShapeKind, createEllipseSelection, createPolygonSelection, createRasterLayer, createRectangleSelection, cropRasterDocument, drawDab, drawQuadraticStrokeSegment, floodFill,
  isRasterDocumentState, parseHexColor, restrictSelectionToAlpha, rotateLayerPixels, rotateSelection, sampleAverage, scaleLayerPixels, scaleSelection, selectionOutlinePath, toHexColor,
  translateLayerPixels, translateSelection, type PixelSelection, type Point, type RasterDocumentState, type RasterGuide, type RasterLayer, type RasterRect, type RasterTextData, type SelectionCombineMode,
  cloneDab, cloneStrokeSegment,
  blurDab, blurStrokeSegment, smudgeStrokeSegment,
  dodgeBurnDab, dodgeBurnStrokeSegment, type DodgeBurnRange,
  spotHealDab, spotHealStrokeSegment, spotHealApply,
  patchFromSelection,
  RASTER_ASSET_MIME, decodeRasterAsset, encodeRasterAsset, isRasterAsset,
} from "@vravio/env-raster";
import { createBufferRevisionOperation, type AssetId, type VravioDocument } from "@vravio/kernel";
import { kernel } from "./kernel";
import { defaultViewport, useShellStore, type DocumentViewport } from "./store";
import { beginBusy, withBusy } from "./busy";
import { diagnostic } from "./diagnostics";
import { identityTextTransform, multiplyTextTransform, renderTextLayerPixels, textBoundsTransform, textFontString } from "./textRender";
import { localized } from "./i18n";

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
function putRegionPixels(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray, region: RasterRect): void {
  if (!region.width || !region.height) return;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, region.width, region.height), region.x, region.y);
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

function unionDirty(current: RasterRect | null, x0: number, y0: number, x1: number, y1: number, pad: number): RasterRect {
  const left = Math.min(x0, x1) - pad, top = Math.min(y0, y1) - pad, right = Math.max(x0, x1) + pad, bottom = Math.max(y0, y1) + pad;
  if (!current) return { x: left, y: top, width: right - left, height: bottom - top };
  const nextLeft = Math.min(current.x, left), nextTop = Math.min(current.y, top);
  return { x: nextLeft, y: nextTop, width: Math.max(current.x + current.width, right) - nextLeft, height: Math.max(current.y + current.height, bottom) - nextTop };
}

const shapeLayerNames: Record<string, string> = {
  rectangle: "Rectangle (Прямоугольник)", roundedRectangle: "Rounded rectangle (Скруглённый прямоугольник)", ellipse: "Ellipse (Эллипс)",
  line: "Line (Линия)", triangle: "Triangle (Треугольник)", polygon: "Polygon (Многоугольник)", star: "Star (Звезда)",
};
const shapeLayerName = (kind: string): string => shapeLayerNames[kind] ?? "Shape (Фигура)";

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

function withActiveLayerPixels(state: RasterDocumentState, pixels: Uint8ClampedArray): RasterDocumentState {
  return { ...state, layers: state.layers.map((layer) => layer.id === state.activeLayerId ? { ...layer, pixels } : layer) };
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
 * Snapshots the document structure, sharing the pixel buffers with it.
 *
 * Every operation that takes a whole-document snapshot took two — the state
 * before and the state after — and copying the pixels of every layer into each
 * of them meant eighty megabytes of memcpy before a rectangle appeared, on the
 * thread that was supposed to be drawing it.
 *
 * The copies bought nothing. A layer's buffer, once it is in the document, is
 * never written in place: every path that edits pixels assigns a freshly
 * allocated buffer in its place, so a snapshot that holds the old reference
 * keeps seeing the old pixels for as long as it needs them. What does have to
 * be copied is the structure around them — the layer array, the layer objects,
 * the selection bounds — because those are mutated in place, and sharing them
 * would let an edit reach back into the history.
 *
 * If a future edit ever writes through `layer.pixels` instead of replacing it,
 * this stops being sound and undo starts returning the edited pixels.
 */
function cloneRasterState(state: RasterDocumentState): RasterDocumentState {
  return { ...state, layers: state.layers.map((layer) => ({ ...layer, ...(layer.text ? { text: structuredClone(layer.text) } : {}), ...(layer.adjustment ? { adjustment: structuredClone(layer.adjustment) } : {}), ...(layer.mask ? { mask: { ...layer.mask } } : {}) })), selection: state.selection ? { mask: state.selection.mask, bounds: { ...state.selection.bounds } } : null, guides: (state.guides ?? []).map((guide) => ({ ...guide })) };
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
  const buffers = (state: RasterDocumentState): Set<ArrayBufferView> => {
    const set = new Set<ArrayBufferView>();
    for (const layer of state.layers) { set.add(layer.pixels); if (layer.mask) set.add(layer.mask.pixels); }
    if (state.selection) set.add(state.selection.mask);
    return set;
  };
  const first = buffers(before), second = buffers(after);
  let bytes = 0;
  for (const buffer of first) if (!second.has(buffer)) bytes += buffer.byteLength;
  for (const buffer of second) if (!first.has(buffer)) bytes += buffer.byteLength;
  return bytes;
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
}

interface TextDraft {
  point: Point;
  value: string;
  layerId?: string;
  mode: "point" | "area" | "path" | "dynamic";
  boxWidth?: number;
  boxHeight?: number;
  path?: { start: Point; control: Point; end: Point; flip?: boolean };
  dynamicPreset?: "circle" | "arch" | "bow";
}

export function RasterWorkspace({ document }: { document: VravioDocument }) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textTransformCanvasRef = useRef<HTMLCanvasElement>(null);
  const brushCursorRef = useRef<SVGGElement>(null);
  const gesture = useRef<{ before: Uint8ClampedArray; working: Uint8ClampedArray; curveStart: Point; pending: Point; pointerId: number; frame: number | null; dirty?: RasterRect | null; strokeBounds?: RasterRect | null; target: "pixels" | "mask"; layerId: string; sourceOffsetX?: number; sourceOffsetY?: number; sourcePixels?: Uint8ClampedArray } | null>(null);
  const selectionGesture = useRef<{ kind: "rectangle" | "ellipse" | "lasso"; from: Point; current: Point; points: Point[]; pointerId: number; mode: SelectionCombineMode; spaceAnchor: Point | null } | null>(null);
  const documentGesture = useRef<
    | { kind: "move" | "crop"; from: Point; current: Point; pointerId: number; before: RasterDocumentState; startDx: number; startDy: number; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; rotation: number; text?: PendingTextTransform; createdTextTransform?: boolean }
    | { kind: "scale"; from: Point; current: Point; pointerId: number; before: RasterDocumentState; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; sourceBounds: RasterRect; handleX: -1 | 0 | 1; handleY: -1 | 0 | 1; dx: number; dy: number; text?: PendingTextTransform }
    | { kind: "rotate"; from: Point; current: Point; pointerId: number; before: RasterDocumentState; basePixels: Uint8ClampedArray; baseSelection: PixelSelection | null; sourceBounds: RasterRect; center: Point; startAngle: number; baseRotation: number; dx: number; dy: number; text?: PendingTextTransform }
    | null
  >(null);
  const pendingTransformRef = useRef<PendingPixelTransform | null>(null);
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
  const lastBrushPointRef = useRef<{ toolId: string; layerId: string; point: Point } | null>(null);
  const textCancelRef = useRef(false);
  const spotHealMaskRef = useRef<{ mask: Uint8ClampedArray; originX: number; originY: number; width: number; height: number; before: Uint8ClampedArray } | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<RasterRect | null>(null);
  const shapeGesture = useRef<{ from: Point; current: Point; pointerId: number } | null>(null);
  const textGesture = useRef<{ from: Point; current: Point; pointerId: number; mode: string } | null>(null);
  const [shapeDraft, setShapeDraft] = useState<RasterRect | null>(null);
  const [textFrameDraft, setTextFrameDraft] = useState<RasterRect | null>(null);
  const tiles = useRef(new RasterTileCache({ tileSize: 256 }));
  const documentDirty = useRef(new DirtyRegion());
  /** What the visible canvas currently holds, so idle renders repaint nothing. */
  const painted = useRef<{ canvas: HTMLCanvasElement | null; revision: number }>({ canvas: null, revision: -1 });
  const [lassoDraft, setLassoDraft] = useState<Point[]>([]);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
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
    () => paintMask(state.selection, activeLayerForMask?.pixels ?? new Uint8ClampedArray(0), state.width, state.height, activeLayerForMask?.lockTransparent === true),
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
    const revised = document.revision !== painted.current.revision;
    painted.current = { canvas, revision: document.revision };

    // A canvas React has just mounted holds nothing, whatever the cache thinks.
    if (canvasChanged) tiles.current.invalidateAll();
    else if (revised) {
      // An empty region means the edit did not report what it touched (a filter, a layer
      // operation, an undo), so the whole document is assumed dirty. Only gestures narrow it.
      const pending = documentDirty.current.isEmpty ? null : documentDirty.current.consume();
      if (pending === null) tiles.current.invalidateAll();
      else for (const rect of pending) tiles.current.invalidate(rect);
    }
    const { repainted } = tiles.current.update(state, { x: 0, y: 0, width: state.width, height: state.height });
    for (const tile of repainted) putRegionPixels(canvas, tile.pixels, tile.rect);
  }, [document.revision, state]);

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
    putPixels(overlay, cropPixels(sourceLayer.pixels, state.width, bounds), overlay.width, overlay.height);
    const canvas = canvasRef.current;
    if (canvas) putPixels(canvas, compositeRasterDocument({ ...state, layers: state.layers.map((item) => item.id === transformPreview.layerId ? { ...item, visible: false } : item) }), state.width, state.height);
  }, [state, transformPreview?.layerId, transformPreview?.text?.initialBounds, transformPreview?.text?.original]);

  useEffect(() => () => { const current = gesture.current; if (current?.frame != null) cancelAnimationFrame(current.frame); }, []);

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

  const renderWorking = (pixels: Uint8ClampedArray, target: "pixels" | "mask" = gesture.current?.target ?? "pixels", layerId = gesture.current?.layerId ?? state.activeLayerId) => {
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

  const scheduleWorkingRender = (current: NonNullable<typeof gesture.current>) => {
    if (current.frame !== null) return;
    current.frame = requestAnimationFrame(() => {
      current.frame = null;
      if (gesture.current !== current) return;
      const dirty = current.dirty;
      current.dirty = null;
      if (dirty) renderWorkingRegion(current.working, dirty); else renderWorking(current.working);
    });
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
    } else if (transforming.kind === "move") {
      const deltaX = point.x - transforming.from.x, deltaY = point.y - transforming.from.y, dx = transforming.startDx + deltaX, dy = transforming.startDy + deltaY;
      if (transforming.text) {
        const current = pendingTransformRef.current; if (!current) return;
        const start = transforming.text.targetBounds;
        const preview: PendingPixelTransform = { ...current, dx, dy, text: { ...transforming.text, targetBounds: { ...start, x: start.x + deltaX, y: start.y + deltaY } } };
        pendingTransformRef.current = preview; setTransformPreview(preview); announceTransform(preview); return;
      }
      const working = translateLayerPixels(transforming.basePixels, state.width, state.height, deltaX, deltaY, transforming.baseSelection);
      // Only where the content was and where it went can have changed. Redrawing
      // the whole canvas each frame composited the entire document to move a
      // square across it. The previous frame's area is folded in as well, or a
      // fast drag would leave the layer painted where it no longer is.
      const was = layerOpaqueBounds(transforming.basePixels, state.width, state.height);
      const now = was ? { ...was, x: was.x + deltaX, y: was.y + deltaY } : null;
      const touched = [movePaintedRef.current, was, now].filter((rect): rect is RasterRect => Boolean(rect));
      if (touched.length) {
        const region = boundingRect(touched);
        movePaintedRef.current = region;
        renderWorkingRegion(working, region);
      } else renderWorking(working);
      const moved = translateSelection(transforming.baseSelection, state.width, state.height, deltaX, deltaY);
      const preview = { before: transforming.before, layerId: transforming.before.activeLayerId, dx, dy, pixels: working, selection: moved, rotation: transforming.rotation };
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
    renderWorking(gesture.current?.working ?? activeRasterLayer(state).pixels);
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

  const appendBrushPoint = (current: NonNullable<typeof gesture.current>, point: Point) => {
    if (Math.hypot(point.x - current.pending.x, point.y - current.pending.y) < 0.05) return;
    const end = { x: (current.pending.x + point.x) / 2, y: (current.pending.y + point.y) / 2, pressure: ((current.pending.pressure ?? 1) + (point.pressure ?? 1)) / 2 };
    const options = toolOptions[activeToolId ?? ""] ?? {};
    const opacity = Number(options.opacity ?? 100) / 100 * Number(options.flow ?? 100) / 100;
    if (activeToolId === "raster.clone") {
      cloneStrokeSegment(current.working, state.width, state.height, current.curveStart, current.pending, current.sourceOffsetX ?? 0, current.sourceOffsetY ?? 0, Number(options.size ?? 24), opacity, brushMask, Number(options.hardness ?? 82) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0), true, false, current.sourcePixels);
    } else if (activeToolId === "raster.blur") {
      blurStrokeSegment(current.working, current.sourcePixels ?? current.before, state.width, state.height, current.curveStart, point, Number(options.size ?? 24), Number(options.strength ?? 50) / 100, brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
    } else if (activeToolId === "raster.smudge") {
      smudgeStrokeSegment(current.working, current.sourcePixels ?? current.before, state.width, state.height, current.curveStart, point, Number(options.size ?? 24), Number(options.strength ?? 50) / 100, brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
    } else if (activeToolId === "raster.dodge" || activeToolId === "raster.burn") {
      dodgeBurnStrokeSegment(current.working, state.width, state.height, current.curveStart, point, Number(options.size ?? 24), Number(options.exposure ?? 50) / 100, activeToolId === "raster.dodge" ? "dodge" : "burn", (options.range as DodgeBurnRange) ?? "midtones", brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
    } else {
      drawQuadraticStrokeSegment(current.working, state.width, state.height, current.curveStart, current.pending, end, Number(options.size ?? 24), parseHexColor(current.target === "mask" && activeToolId === "raster.eraser" ? "#ffffff" : paintColor), opacity, current.target === "pixels" && activeToolId === "raster.eraser", brushMask, activeToolId === "raster.pencil" ? 1 : Number(options.hardness ?? 82) / 100, Number(options.spacing ?? 12) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0), options.pressureSize !== false, options.pressureOpacity === true);
    }
    // Union every point the segment could have touched, padded by the brush radius (plus a
    // margin for the neighbourhood-sampling tools) so the repaint never clips the stroke.
    const pad = Number(options.size ?? 24) / 2 + 2;
    current.dirty = unionDirty(current.dirty ?? null, current.curveStart.x, current.curveStart.y, current.pending.x, current.pending.y, pad);
    current.dirty = unionDirty(current.dirty, point.x, point.y, end.x, end.y, pad);
    // `dirty` is consumed every frame; `strokeBounds` survives so the commit can tell the tile
    // cache exactly what the finished stroke changed.
    current.strokeBounds = unionDirty(current.strokeBounds ?? null, current.dirty.x, current.dirty.y, current.dirty.x + current.dirty.width, current.dirty.y + current.dirty.height, 0);
    current.curveStart = end;
    current.pending = point;
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
      kernel.documents.update<RasterDocumentState>(document.id, (current) => { const layer = current.layers.find((item) => item.id === layerId); if (!layer) return; if (target === "mask" && layer.mask) layer.mask.pixels = rgbaToMask(buffer); else layer.pixels = buffer.slice(); });
    };

    // Show the result now; the gesture is over and the user is looking at it.
    assign(after);

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
          await history.record({ label, memoryEstimate: before.byteLength + after.byteLength, redo: () => assign(after), undo: () => assign(before) });
          return;
        }
        const previousRev = kernel.assets.mustGet(assetId).head;
        const nextRev = await kernel.assets.commitRevision(assetId, toBytes(after, state.width, state.height), "raster", label);
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
      const wasThere = sourceLayer ? alphaBounds(sourceLayer.pixels, state.width, state.height) : null;
      const isThere = alphaBounds(pending.pixels, state.width, state.height);
      if (wasThere) documentDirty.current.add(wasThere);
      if (isThere) documentDirty.current.add(isThere);
      if (!wasThere && !isThere) documentDirty.current.addEverything();
      layer.pixels = pending.pixels.slice();
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
      const selection = before.selection ? restrictSelectionToAlpha(before.selection, layer.pixels, state.width, state.height) : null;
      if (before.selection && !selection) { diagnostic("info", "transform", "Transform ignored: selection contains no opaque pixels", { documentId: document.id, layerId: layer.id }); return; }
      if (!selection && !alphaBounds(layer.pixels, state.width, state.height)) { diagnostic("info", "transform", "Transform ignored: layer is empty", { documentId: document.id, layerId: layer.id }); return; }
      const bounds = layer.text?.visualBounds?.width ? layer.text.visualBounds : alphaBounds(layer.pixels, state.width, state.height)!;
      const pending: PendingPixelTransform = { before, layerId: layer.id, dx: 0, dy: 0, pixels: liveText ? layer.pixels : layer.pixels.slice(), selection, rotation: 0, ...(liveText ? { text: { original: structuredClone(layer.text!), initialBounds: { ...bounds }, targetBounds: { ...bounds } } } : {}) };
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

  const commitSelection = async (before: PixelSelection | null, after: PixelSelection | null) => {
    const history = kernel.historyByDocument.get(document.id);
    if (!history) throw new Error(`History missing for ${document.id}`);
    const clone = (selection: PixelSelection | null): PixelSelection | null => selection ? { mask: selection.mask.slice(), bounds: { ...selection.bounds } } : null;
    const assign = (selection: PixelSelection | null): void => { kernel.documents.update<RasterDocumentState>(document.id, (current) => { current.selection = clone(selection); }); };
    await history.execute({ label: "Marquee Selection (Прямоугольное выделение)", memoryEstimate: (before?.mask.byteLength ?? 0) + (after?.mask.byteLength ?? 0), redo: () => assign(after), undo: () => assign(before) });
  };

  const commitText = () => {
    textCancelRef.current = false;
    if (!textDraft?.value) { setTextDraft(null); return; }
    const before = cloneRasterState(state);
    const existing = textDraft.layerId ? state.layers.find((item) => item.id === textDraft.layerId) : null;
    const layer: RasterLayer = existing ? { ...existing, pixels: existing.pixels.slice(), ...(existing.text ? { text: { ...existing.text } } : {}) } : createRasterLayer(state.width, state.height, textDraft.value.slice(0, 28));
    const options = toolOptions["raster.text"] ?? {};
    const fontSize = existing?.text?.fontSize ?? Number(options.fontSize ?? 48), fontFamily = existing?.text?.fontFamily ?? String(options.fontFamily ?? "Arial");
    const textX = existing?.text?.x ?? textDraft.point.x, textY = existing?.text?.y ?? textDraft.point.y, lineHeight = existing?.text?.lineHeight ?? 1.2, letterSpacing = existing?.text?.letterSpacing ?? 0, align = existing?.text?.align ?? "left", color = existing?.text?.color ?? foregroundColor;
    const bold = existing?.text?.bold ?? false, italic = existing?.text?.italic ?? false, underline = existing?.text?.underline ?? false;
    const boxWidth = existing?.text?.boxWidth ?? textDraft.boxWidth, boxHeight = existing?.text?.boxHeight ?? textDraft.boxHeight, path = existing?.text?.path ?? textDraft.path, dynamicPreset = existing?.text?.dynamicPreset ?? textDraft.dynamicPreset;
    const textData = { value: textDraft.value, x: textX, y: textY, fontFamily, fontSize, lineHeight, letterSpacing, align, color, bold, italic, underline, mode: existing?.text?.mode ?? textDraft.mode, ...(boxWidth !== undefined ? { boxWidth } : {}), ...(boxHeight !== undefined ? { boxHeight } : {}), ...(path ? { path } : {}), ...(dynamicPreset ? { dynamicPreset } : {}) };
    layer.text = textData;
    // Rasterising type paints the whole document surface and then scans it for
    // the glyph bounds; on a large canvas that is long enough to look stuck.
    layer.pixels = withBusy("Rasterising type (Растеризация текста)", () => renderTextLayerPixels(textData, state.width, state.height));
    layer.kind = "text";
    layer.name = textDraft.value.slice(0, 28) || layer.name;
    const after = cloneRasterState(state); const index = after.layers.findIndex((item) => item.id === layer.id); if (index >= 0) after.layers[index] = layer; else after.layers.push(layer); after.activeLayerId = layer.id;
    setTextDraft(null);
    void commitDocumentState(before, after, "Type Layer (Текстовый слой)");
  };

  const cancelText = () => {
    textCancelRef.current = true;
    setTextDraft(null);
    const canvas = canvasRef.current;
    if (canvas) putPixels(canvas, compositeRasterDocument(state), state.width, state.height);
  };

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
    const pendingTransform = pendingTransformRef.current;
    if (pendingTransform) {
      const bounds = pendingTransform.text?.targetBounds ?? pendingTransform.selection?.bounds ?? alphaBounds(pendingTransform.pixels, state.width, state.height), tolerance = 11 / viewport.zoom;
      if (!bounds) { pendingTransformRef.current = null; setTransformPreview(null); announceTransform(null); diagnostic("warn", "transform", "Discarded invalid empty pending transform", { documentId: document.id, layerId: pendingTransform.layerId }); return; }
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
    if (activeToolId === "raster.clone") {
      if (maskTarget) return;
      if (event.altKey) {
        sourcePointRef.current = { x: point.x, y: point.y };
        cloneOffsetRef.current = null;
        return;
      }
      if (!sourcePointRef.current) return;
      canvas.setPointerCapture(event.pointerId);
      const before = layer.pixels.slice();
      const working = layer.pixels.slice();
      const options = toolOptions[activeToolId] ?? {};
      const opacity = Number(options.opacity ?? 100) / 100;
      const previous = lastBrushPointRef.current, shiftFrom = event.shiftKey && previous?.toolId === activeToolId && previous.layerId === layer.id ? previous.point : null;
      const alignMode = String(options.alignMode ?? "registered");
      if (!cloneOffsetRef.current || alignMode === "none") cloneOffsetRef.current = { x: sourcePointRef.current.x - point.x, y: sourcePointRef.current.y - point.y };
      const sourceOffsetX = cloneOffsetRef.current.x, sourceOffsetY = cloneOffsetRef.current.y;
      if (shiftFrom) {
        cloneStrokeSegment(working, state.width, state.height, shiftFrom, point, sourceOffsetX, sourceOffsetY, Number(options.size ?? 24), opacity, brushMask, Number(options.hardness ?? 82) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0), true, false, before);
        lastBrushPointRef.current = { toolId: activeToolId, layerId: layer.id, point }; renderWorking(working); void commitPixels(before, working, "Clone Line (Линия штампа)"); return;
      }
      cloneDab(working, state.width, state.height, point.x + sourceOffsetX, point.y + sourceOffsetY, point.x, point.y, Number(options.size ?? 24), opacity, Number(options.hardness ?? 82) / 100, brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0), true, false, before);
      gesture.current = { before, working, curveStart: point, pending: point, pointerId: event.pointerId, frame: null, target: "pixels", layerId: layer.id, sourceOffsetX, sourceOffsetY, sourcePixels: before };
      renderWorking(working);
      return;
    }
    if (activeToolId === "raster.spotHeal") {
      if (maskTarget) return;
      canvas.setPointerCapture(event.pointerId);
      const before = layer.pixels.slice();
      const options = toolOptions[activeToolId] ?? {};
      const size = Number(options.size ?? 24);
      const radius = Math.ceil(size / 2) + 8;
      const originX = Math.max(0, Math.floor(point.x) - radius);
      const originY = Math.max(0, Math.floor(point.y) - radius);
      const originX2 = Math.min(state.width, Math.ceil(point.x) + radius);
      const originY2 = Math.min(state.height, Math.ceil(point.y) + radius);
      const maskW = originX2 - originX;
      const maskH = originY2 - originY;
      const mask = new Uint8ClampedArray(maskW * maskH);
      const previous = lastBrushPointRef.current, shiftFrom = event.shiftKey && previous?.toolId === activeToolId && previous.layerId === layer.id ? previous.point : null;
      if (shiftFrom) {
        const lineOriginX = Math.max(0, Math.floor(Math.min(shiftFrom.x, point.x)) - radius), lineOriginY = Math.max(0, Math.floor(Math.min(shiftFrom.y, point.y)) - radius), lineRight = Math.min(state.width, Math.ceil(Math.max(shiftFrom.x, point.x)) + radius), lineBottom = Math.min(state.height, Math.ceil(Math.max(shiftFrom.y, point.y)) + radius), lineWidth = lineRight - lineOriginX, lineHeight = lineBottom - lineOriginY, lineMask = new Uint8ClampedArray(lineWidth * lineHeight);
        spotHealStrokeSegment(lineMask, lineOriginX, lineOriginY, lineWidth, lineHeight, shiftFrom.x, shiftFrom.y, point.x, point.y, size, Number(options.hardness ?? 82) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
        const working = before.slice(); spotHealApply(working, state.width, state.height, lineMask, lineOriginX, lineOriginY, lineWidth, lineHeight, Number(options.opacity ?? 100) / 100);
        lastBrushPointRef.current = { toolId: activeToolId, layerId: layer.id, point }; renderWorking(working); void commitPixels(before, working, "Spot Healing Line (Линия восстановления)"); return;
      }
      spotHealDab(mask, originX, originY, maskW, maskH, point.x, point.y, size, Number(options.hardness ?? 82) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
      spotHealMaskRef.current = { mask, originX, originY, width: maskW, height: maskH, before };
      gesture.current = { before, working: before.slice(), curveStart: point, pending: point, pointerId: event.pointerId, frame: null, target: "pixels", layerId: layer.id };
      renderSpotHealOverlay(mask, originX, originY, maskW, maskH);
      return;
    }
    if (activeToolId === "raster.patch") {
      if (maskTarget) return;
      if (!state.selection) return;
      canvas.setPointerCapture(event.pointerId);
      gesture.current = { before: layer.pixels.slice(), working: layer.pixels.slice(), curveStart: point, pending: point, pointerId: event.pointerId, frame: null, target: "pixels", layerId: layer.id };
      return;
    }
    const paintingTool = activeToolId === "raster.brush" || activeToolId === "raster.pencil" || activeToolId === "raster.highlighter" || activeToolId === "raster.eraser" || activeToolId === "raster.blur" || activeToolId === "raster.smudge" || activeToolId === "raster.dodge" || activeToolId === "raster.burn";
    if (event.altKey && paintingTool) { if (maskTarget?.mask) { const sample = maskTarget.mask.pixels[Math.max(0, Math.min(maskTarget.mask.pixels.length - 1, Math.floor(point.y) * state.width + Math.floor(point.x)))] ?? 0; setMaskForegroundWhite(document.id, sample >= 128); } else setForegroundColor(toHexColor(sampleAverage(compositeRasterDocument(state), state.width, state.height, point.x, point.y, 1))); return; }
    if (activeToolId === "raster.text") {
      const hit = [...state.layers].reverse().find((item) => { if (item.kind !== "text" || !item.text) return false; const lines = item.text.value.split("\n"), width = item.text.boxWidth ?? Math.max(...lines.map((line) => line.length), 1) * item.text.fontSize * .65, height = item.text.boxHeight ?? lines.length * item.text.fontSize * item.text.lineHeight; const left = item.text.path ? Math.min(item.text.path.start.x, item.text.path.end.x, item.text.path.control.x) : item.text.x, top = item.text.path ? Math.min(item.text.path.start.y, item.text.path.end.y, item.text.path.control.y) - item.text.fontSize : item.text.y; return point.x >= left && point.x <= left + Math.max(width, item.text.path ? Math.abs(item.text.path.end.x - item.text.path.start.x) : 0) && point.y >= top && point.y <= top + Math.max(height, item.text.fontSize * 2); });
      if (hit?.text) kernel.documents.update<RasterDocumentState>(document.id, (current) => { current.activeLayerId = hit.id; });
      if (hit?.text) {
        textCancelRef.current = false;
        setTextDraft({ point: { x: hit.text.x, y: hit.text.y }, value: hit.text.value, layerId: hit.id, mode: hit.text.mode ?? (hit.text.boxWidth ? "area" : "point"), ...(hit.text.boxWidth !== undefined ? { boxWidth: hit.text.boxWidth } : {}), ...(hit.text.boxHeight !== undefined ? { boxHeight: hit.text.boxHeight } : {}), ...(hit.text.path ? { path: hit.text.path } : {}), ...(hit.text.dynamicPreset ? { dynamicPreset: hit.text.dynamicPreset } : {}) });
        putPixels(canvas, compositeRasterDocument({ ...state, layers: state.layers.map((item) => item.id === hit.id ? { ...item, visible: false } : item) }), state.width, state.height);
        return;
      }
      const mode = String(toolOptions["raster.text"]?.textMode ?? "auto");
      canvas.setPointerCapture(event.pointerId);
      textGesture.current = { from: point, current: point, pointerId: event.pointerId, mode };
      setTextFrameDraft({ x: point.x, y: point.y, width: 0, height: 0 });
      return;
    }
    if (activeToolId === "raster.shape") {
      if (layer.locked) return;
      canvas.setPointerCapture(event.pointerId);
      shapeGesture.current = { from: point, current: point, pointerId: event.pointerId };
      setShapeDraft({ x: point.x, y: point.y, width: 0, height: 0 });
      return;
    }
    if (activeToolId === "raster.marquee" || activeToolId === "raster.ellipseMarquee" || activeToolId === "raster.lasso") {
      canvas.setPointerCapture(event.pointerId);
      const kind = activeToolId === "raster.lasso" ? "lasso" : activeToolId === "raster.ellipseMarquee" ? "ellipse" : "rectangle";
      // Photoshop reads Shift and Alt at the moment the drag begins to decide how
      // the new selection combines with the old one. The same keys pressed later,
      // mid-drag, mean something else entirely — square, and from-centre — so the
      // mode has to be captured here rather than looked up when the drag ends.
      const marqueeOptions = toolOptions[activeToolId] ?? {};
      const mode = (event.shiftKey && event.altKey ? "intersect" : event.shiftKey ? "add" : event.altKey ? "subtract" : String(marqueeOptions.mode ?? "replace")) as SelectionCombineMode;
      selectionGesture.current = { kind, from: point, current: point, points: [point], pointerId: event.pointerId, mode, spaceAnchor: null };
      setSelectionDraft({ x: point.x, y: point.y, width: 0, height: 0 });
      setLassoDraft(kind === "lasso" ? [point] : []);
      return;
    }
    if (activeToolId === "raster.magicWand") {
      const options = toolOptions[activeToolId] ?? {};
      const source = options.allLayers === false ? layer.pixels : compositeRasterDocument(state);
      const incoming = restrictSelectionToAlpha(createContiguousColorSelection(source, state.width, state.height, point.x, point.y, Number(options.tolerance ?? 32)), source, state.width, state.height);
      const mode = (event.shiftKey && event.altKey ? "intersect" : event.shiftKey ? "add" : event.altKey ? "subtract" : "replace") as SelectionCombineMode;
      void commitSelection(state.selection, incoming ? combineSelections(state.selection, incoming, state.width, state.height, mode) : mode === "replace" ? null : state.selection);
      return;
    }
    if (activeToolId === "raster.crop" || activeToolId === "raster.move") {
      const effectiveSelection = activeToolId === "raster.move" && state.selection ? restrictSelectionToAlpha(state.selection, layer.pixels, state.width, state.height) : null;
      if (activeToolId === "raster.move" && state.selection && !effectiveSelection) { diagnostic("info", "move", "Move ignored: selection contains no opaque pixels", { documentId: document.id, layerId: layer.id }); return; }
      if (activeToolId === "raster.move" && !state.selection && !(layer.kind === "text" && layer.text?.visualBounds?.width ? layer.text.visualBounds : alphaBounds(layer.pixels, state.width, state.height))) { diagnostic("info", "move", "Move ignored: layer is empty", { documentId: document.id, layerId: layer.id }); return; }
      canvas.setPointerCapture(event.pointerId);
      let pending = activeToolId === "raster.move" ? pendingTransformRef.current : null, createdTextTransform = false;
      if (activeToolId === "raster.move" && !pending && layer.kind === "text" && layer.text && !effectiveSelection) {
        const bounds = layer.text.visualBounds?.width ? layer.text.visualBounds : alphaBounds(layer.pixels, state.width, state.height)!;
        pending = { before: state, layerId: layer.id, dx: 0, dy: 0, pixels: layer.pixels, selection: null, rotation: 0, text: { original: structuredClone(layer.text), initialBounds: { ...bounds }, targetBounds: { ...bounds } } };
        pendingTransformRef.current = pending; setTransformPreview(pending); announceTransform(pending);
        createdTextTransform = true;
      }
      documentGesture.current = { kind: activeToolId === "raster.crop" ? "crop" : "move", from: point, current: point, pointerId: event.pointerId, before: pending?.before ?? cloneRasterState(gestureState), startDx: pending?.dx ?? 0, startDy: pending?.dy ?? 0, basePixels: pending ? (pending.text ? pending.pixels : pending.pixels.slice()) : layer.pixels.slice(), baseSelection: pending?.selection ? { mask: pending.selection.mask.slice(), bounds: { ...pending.selection.bounds } } : effectiveSelection ? { mask: effectiveSelection.mask.slice(), bounds: { ...effectiveSelection.bounds } } : null, rotation: pending?.rotation ?? 0, ...(pending?.text ? { text: pending.text } : {}), ...(createdTextTransform ? { createdTextTransform: true } : {}) };
      setSelectionDraft(activeToolId === "raster.crop" ? { x: point.x, y: point.y, width: 0, height: 0 } : null);
      return;
    }
    if (layer.locked) return;
    if (activeToolId === "raster.eyedropper") {
      const options = toolOptions[activeToolId] ?? {};
      const sample = options.sample === "point" || options.sample === undefined ? 1 : Number(options.sample);
      const source = options.allLayers === false ? layer.pixels : compositeRasterDocument(state);
      const color = toHexColor(sampleAverage(source, state.width, state.height, point.x, point.y, sample));
      setForegroundColor(color);
      return;
    }
    if (activeToolId === "raster.fill") {
      const before = maskTarget?.mask ? maskToRgba(maskTarget.mask.pixels) : layer.pixels.slice(), after = before.slice(), options = toolOptions[activeToolId] ?? {};
      const changed = floodFill(after, state.width, state.height, point.x, point.y, parseHexColor(paintColor), Number(options.tolerance ?? 32), brushMask);
      if (changed) void commitPixels(before, after, maskTarget ? "Fill Layer Mask (Заливка маски слоя)" : "Paint Bucket (Заливка)", maskTarget ? "mask" : "pixels", paintTargetId);
      return;
    }
    if (activeToolId !== "raster.brush" && activeToolId !== "raster.eraser" && activeToolId !== "raster.pencil" && activeToolId !== "raster.highlighter" && activeToolId !== "raster.blur" && activeToolId !== "raster.smudge" && activeToolId !== "raster.dodge" && activeToolId !== "raster.burn") return;
    canvas.setPointerCapture(event.pointerId);
    if (maskTarget && (activeToolId === "raster.blur" || activeToolId === "raster.smudge" || activeToolId === "raster.dodge" || activeToolId === "raster.burn")) return;
    const before = maskTarget?.mask ? maskToRgba(maskTarget.mask.pixels) : layer.pixels.slice(), working = before.slice();
    const options = toolOptions[activeToolId] ?? {};
    const opacity = Number(options.opacity ?? 100) / 100 * Number(options.flow ?? 100) / 100;
    const previous = lastBrushPointRef.current, shiftFrom = event.shiftKey && previous?.toolId === activeToolId && previous.layerId === brushTargetKey ? previous.point : null;
    if (shiftFrom) {
      if (activeToolId === "raster.blur") blurStrokeSegment(working, before, state.width, state.height, shiftFrom, point, Number(options.size ?? 24), Number(options.strength ?? 50) / 100, brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
      else if (activeToolId === "raster.smudge") smudgeStrokeSegment(working, before, state.width, state.height, shiftFrom, point, Number(options.size ?? 24), Number(options.strength ?? 50) / 100, brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
      else if (activeToolId === "raster.dodge" || activeToolId === "raster.burn") dodgeBurnStrokeSegment(working, state.width, state.height, shiftFrom, point, Number(options.size ?? 24), Number(options.exposure ?? 50) / 100, activeToolId === "raster.dodge" ? "dodge" : "burn", (options.range as DodgeBurnRange) ?? "midtones", brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
      else { const control = { x: (shiftFrom.x + point.x) / 2, y: (shiftFrom.y + point.y) / 2, pressure: 1 }; drawQuadraticStrokeSegment(working, state.width, state.height, shiftFrom, control, point, Number(options.size ?? 24), parseHexColor(maskTarget && activeToolId === "raster.eraser" ? "#ffffff" : paintColor), opacity, !maskTarget && activeToolId === "raster.eraser", brushMask, activeToolId === "raster.pencil" ? 1 : Number(options.hardness ?? 82) / 100, Number(options.spacing ?? 12) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0), options.pressureSize !== false, options.pressureOpacity === true); }
      lastBrushPointRef.current = { toolId: activeToolId, layerId: brushTargetKey, point }; renderWorking(working, maskTarget ? "mask" : "pixels", paintTargetId); void commitPixels(before, working, maskTarget ? "Paint Layer Mask (Рисование по маске слоя)" : "Straight Brush Line (Прямая линия кисти)", maskTarget ? "mask" : "pixels", paintTargetId); return;
    }
    if (activeToolId === "raster.blur") blurDab(working, before, state.width, state.height, point, Number(options.size ?? 24), Number(options.strength ?? 50) / 100, brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
    else if (activeToolId === "raster.dodge" || activeToolId === "raster.burn") dodgeBurnDab(working, state.width, state.height, point, Number(options.size ?? 24), Number(options.exposure ?? 50) / 100, activeToolId === "raster.dodge" ? "dodge" : "burn", (options.range as DodgeBurnRange) ?? "midtones", brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
    else if (activeToolId !== "raster.smudge") drawDab(working, state.width, state.height, point, Number(options.size ?? 24), parseHexColor(maskTarget && activeToolId === "raster.eraser" ? "#ffffff" : paintColor), opacity, !maskTarget && activeToolId === "raster.eraser", activeToolId === "raster.pencil" ? 1 : Number(options.hardness ?? 82) / 100, brushMask, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0), options.pressureSize !== false, options.pressureOpacity === true);
    gesture.current = { before, working, curveStart: point, pending: point, pointerId: event.pointerId, frame: null, target: maskTarget ? "mask" : "pixels", layerId: paintTargetId, sourcePixels: before };
    renderWorking(working, maskTarget ? "mask" : "pixels", paintTargetId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const textDrawing = textGesture.current;
    if (textDrawing && textDrawing.pointerId === event.pointerId) {
      const workspace = workspaceRef.current; if (!workspace) return;
      const point = pointFromNativeEvent(workspace, viewport, state.width, state.height, event.nativeEvent);
      textDrawing.current = point;
      setTextFrameDraft({ x: Math.min(textDrawing.from.x, point.x), y: Math.min(textDrawing.from.y, point.y), width: Math.abs(point.x - textDrawing.from.x), height: Math.abs(point.y - textDrawing.from.y) });
      return;
    }
    const selecting = selectionGesture.current;
    if (selecting && selecting.pointerId === event.pointerId) {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const point = pointFromNativeEvent(workspace, viewport, state.width, state.height, event.nativeEvent);
      // Holding space mid-drag slides the whole marquee instead of resizing it,
      // which is the only way to correct a start point without beginning again.
      if (spaceHeld) {
        const anchor = selecting.spaceAnchor ?? point;
        selecting.from = { x: selecting.from.x + (point.x - anchor.x), y: selecting.from.y + (point.y - anchor.y) };
        selecting.current = { x: selecting.current.x + (point.x - anchor.x), y: selecting.current.y + (point.y - anchor.y) };
        selecting.spaceAnchor = point;
      } else {
        selecting.spaceAnchor = null;
        selecting.current = point;
      }
      if (selecting.kind === "lasso") { selecting.points.push(selecting.current); setLassoDraft([...selecting.points]); }
      else setSelectionDraft(marqueeRect(selecting.from.x, selecting.from.y, selecting.current.x, selecting.current.y, { square: event.shiftKey, fromCentre: event.altKey }));
      return;
    }
    const shaping = shapeGesture.current;
    if (shaping && shaping.pointerId === event.pointerId) {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const point = pointFromNativeEvent(workspace, viewport, state.width, state.height, event.nativeEvent);
      shaping.current = point;
      setShapeDraft({ x: shaping.from.x, y: shaping.from.y, width: point.x - shaping.from.x, height: point.y - shaping.from.y });
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
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    if (activeToolId === "raster.spotHeal" && spotHealMaskRef.current) {
      const maskData = spotHealMaskRef.current;
      const options = toolOptions[activeToolId] ?? {};
      const size = Number(options.size ?? 24);
      const radius = Math.ceil(size / 2) + 8;
      for (const sample of event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]) {
        const p = pointFromNativeEvent(workspace, viewport, state.width, state.height, sample);
        const newLeft = Math.max(0, Math.floor(p.x) - radius);
        const newTop = Math.max(0, Math.floor(p.y) - radius);
        const newRight = Math.min(state.width, Math.ceil(p.x) + radius);
        const newBottom = Math.min(state.height, Math.ceil(p.y) + radius);
        if (newLeft < maskData.originX || newTop < maskData.originY || newRight > maskData.originX + maskData.width || newBottom > maskData.originY + maskData.height) {
          const expandedOriginX = Math.min(maskData.originX, newLeft);
          const expandedOriginY = Math.min(maskData.originY, newTop);
          const expandedW = Math.max(maskData.originX + maskData.width, newRight) - expandedOriginX;
          const expandedH = Math.max(maskData.originY + maskData.height, newBottom) - expandedOriginY;
          const expanded = new Uint8ClampedArray(expandedW * expandedH);
          for (let y = 0; y < maskData.height; y++) {
            for (let x = 0; x < maskData.width; x++) {
              const m = maskData.mask[y * maskData.width + x]!;
              if (m > 0) expanded[(y + maskData.originY - expandedOriginY) * expandedW + (x + maskData.originX - expandedOriginX)] = m;
            }
          }
          maskData.mask = expanded;
          maskData.originX = expandedOriginX;
          maskData.originY = expandedOriginY;
          maskData.width = expandedW;
          maskData.height = expandedH;
        }
        spotHealDab(maskData.mask, maskData.originX, maskData.originY, maskData.width, maskData.height, p.x, p.y, size, Number(options.hardness ?? 82) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0));
      }
      renderSpotHealOverlay(maskData.mask, maskData.originX, maskData.originY, maskData.width, maskData.height);
      return;
    }
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    for (const sample of samples) appendBrushPoint(current, pointFromNativeEvent(workspace, viewport, state.width, state.height, sample));
    scheduleWorkingRender(current);
  };

  const finishGesture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const textDrawing = textGesture.current;
    if (textDrawing && textDrawing.pointerId === event.pointerId) {
      textGesture.current = null; setTextFrameDraft(null);
      const distance = Math.hypot(textDrawing.current.x - textDrawing.from.x, textDrawing.current.y - textDrawing.from.y);
      const end = distance >= 4 ? textDrawing.current : { x: Math.min(state.width, textDrawing.from.x + 240), y: textDrawing.from.y };
      const width = Math.max(24, Math.abs(end.x - textDrawing.from.x)), height = Math.max(24, Math.abs(end.y - textDrawing.from.y));
      if (textDrawing.mode === "auto") {
        setTextDraft({ point: textDrawing.from, value: "", mode: distance >= 4 ? "area" : "point", ...(distance >= 4 ? { boxWidth: width, boxHeight: height } : {}) });
      } else {
        const dynamic = textDrawing.mode.startsWith("dynamic"), preset = textDrawing.mode === "dynamicCircle" ? "circle" : textDrawing.mode === "dynamicBow" ? "bow" : "arch";
        const middle = { x: (textDrawing.from.x + end.x) / 2, y: (textDrawing.from.y + end.y) / 2 };
        const control = preset === "bow" ? { x: middle.x, y: middle.y + Math.max(30, width * .22) } : preset === "circle" ? { x: middle.x, y: middle.y - Math.max(60, width * .65) } : { x: middle.x, y: middle.y - Math.max(30, width * .28) };
        setTextDraft({ point: textDrawing.from, value: "", mode: dynamic ? "dynamic" : "path", boxWidth: width, boxHeight: Math.max(height, width * .5), path: { start: textDrawing.from, control, end }, ...(dynamic ? { dynamicPreset: preset as "circle" | "arch" | "bow" } : {}) });
      }
      return;
    }
    const shaping = shapeGesture.current;
    if (shaping && shaping.pointerId === event.pointerId) {
      shapeGesture.current = null;
      setShapeDraft(null);
      const rect = { x: shaping.from.x, y: shaping.from.y, width: shaping.current.x - shaping.from.x, height: shaping.current.y - shaping.from.y };
      if (Math.abs(rect.width) < 1 && Math.abs(rect.height) < 1) return;
      const options = toolOptions["raster.shape"] ?? {};
      const mode = String(options.shapeMode ?? "fill");
      const kind = String(options.shapeKind ?? "rectangle") as ShapeKind;
      // Photoshop puts every shape on its own layer, which keeps them independently
      // movable and restyleable instead of being flattened into whatever was selected.
      const before = cloneRasterState(state), after = cloneRasterState(state);
      const shapeLayer = createRasterLayer(state.width, state.height, shapeLayerName(kind));
      drawShape(shapeLayer.pixels, state.width, state.height, {
        kind,
        rect,
        cornerRadius: Number(options.cornerRadius ?? 16),
        sides: Number(options.sides ?? 5),
        strokeWidth: Number(options.strokeWidth ?? 4),
        fill: mode === "stroke" ? null : parseHexColor(String(options.color ?? foregroundColor)),
        stroke: mode === "fill" ? null : parseHexColor(String(options.strokeColor ?? "#ffffff")),
      }, state.selection?.mask);
      appendLayer(after, shapeLayer);
      after.activeLayerId = shapeLayer.id;
      const strokePad = Number(options.strokeWidth ?? 4) + 2;
      documentDirty.current.add({ x: Math.min(rect.x, rect.x + rect.width) - strokePad, y: Math.min(rect.y, rect.y + rect.height) - strokePad, width: Math.abs(rect.width) + strokePad * 2, height: Math.abs(rect.height) + strokePad * 2 });
      void commitDocumentState(before, after, "Shape (Фигура)");
      return;
    }
    const selecting = selectionGesture.current;
    if (selecting && selecting.pointerId === event.pointerId) {
      selectionGesture.current = null;
      setSelectionDraft(null);
      setLassoDraft([]);
      const optionId = selecting.kind === "lasso" ? "raster.lasso" : selecting.kind === "ellipse" ? "raster.ellipseMarquee" : "raster.marquee";
      const options = toolOptions[optionId] ?? {};
      const feather = Number(options.feather ?? 0);
      const corners = marqueeCorners(selecting.from.x, selecting.from.y, selecting.current.x, selecting.current.y, { square: event.shiftKey, fromCentre: event.altKey });
      const incoming = selecting.kind === "lasso"
        ? createPolygonSelection(state.width, state.height, selecting.points, feather)
        : selecting.kind === "ellipse"
          ? createEllipseSelection(state.width, state.height, corners.fromX, corners.fromY, corners.toX, corners.toY, feather)
          : createRectangleSelection(state.width, state.height, corners.fromX, corners.fromY, corners.toX, corners.toY, feather);
      const mode = selecting.mode;
      void options;
      const opaqueIncoming = restrictSelectionToAlpha(incoming, activeRasterLayer(state).pixels, state.width, state.height);
      const combined = opaqueIncoming ? combineSelections(state.selection, opaqueIncoming, state.width, state.height, mode) : mode === "replace" ? null : state.selection;
      void commitSelection(state.selection, combined);
      return;
    }
    const transforming = documentGesture.current;
    if (transforming && transforming.pointerId === event.pointerId) {
      if (transformFrameRef.current !== null) { cancelAnimationFrame(transformFrameRef.current); transformFrameRef.current = null; }
      documentGesture.current = null;
      setSelectionDraft(null);
      if (transforming.kind === "scale" || transforming.kind === "rotate") { applyTransformFrame(transforming); return; }
      const dx = transforming.startDx + transforming.current.x - transforming.from.x, dy = transforming.startDy + transforming.current.y - transforming.from.y;
      if (transforming.kind === "move") {
        const deltaX = transforming.current.x - transforming.from.x, deltaY = transforming.current.y - transforming.from.y;
        if (Math.hypot(deltaX, deltaY) < .25) { if (transforming.createdTextTransform) { pendingTransformRef.current = null; setTransformPreview(null); announceTransform(null); } const canvas = canvasRef.current; if (canvas) putPixels(canvas, compositeRasterDocument(state), state.width, state.height); return; }
        if (transforming.text) { applyTransformFrame(transforming); return; }
        const pixels = translateLayerPixels(transforming.basePixels, state.width, state.height, deltaX, deltaY, transforming.baseSelection);
        const preview = { before: transforming.before, layerId: transforming.before.activeLayerId, dx, dy, pixels, selection: translateSelection(transforming.baseSelection, state.width, state.height, deltaX, deltaY), rotation: transforming.rotation };
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
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const options = toolOptions[activeToolId ?? ""] ?? {};
    const opacity = Number(options.opacity ?? 100) / 100 * Number(options.flow ?? 100) / 100;
    if (activeToolId === "raster.spotHeal" && spotHealMaskRef.current) {
      const maskData = spotHealMaskRef.current;
      const working = maskData.before.slice();
      spotHealApply(working, state.width, state.height, maskData.mask, maskData.originX, maskData.originY, maskData.width, maskData.height, Number(options.opacity ?? 100) / 100);
      spotHealMaskRef.current = null;
      if (current.frame !== null) cancelAnimationFrame(current.frame);
      gesture.current = null;
      lastBrushPointRef.current = { toolId: activeToolId, layerId: activeRasterLayer(state).id, point: pointFromNativeEvent(workspace, viewport, state.width, state.height, event.nativeEvent) };
      void commitPixels(maskData.before, working, "Spot Healing (Точечное восстановление)");
      return;
    }
    appendBrushPoint(current, pointFromNativeEvent(workspace, viewport, state.width, state.height, event.nativeEvent));
    if (activeToolId === "raster.clone") {
      cloneStrokeSegment(current.working, state.width, state.height, current.curveStart, current.pending, current.sourceOffsetX ?? 0, current.sourceOffsetY ?? 0, Number(options.size ?? 24), opacity, brushMask, Number(options.hardness ?? 82) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0), true, false, current.sourcePixels);
    } else if (activeToolId === "raster.patch") {
      const patchOffsetX = current.pending.x - current.curveStart.x;
      const patchOffsetY = current.pending.y - current.curveStart.y;
      patchFromSelection(current.working, state.width, state.height, brushMask ?? null, state.selection?.bounds ?? { x: 0, y: 0, width: state.width, height: state.height }, patchOffsetX, patchOffsetY, Number(options.opacity ?? 100) / 100, (options.mode as "source" | "destination") ?? "source", Number(options.feather ?? 0));
    } else if (activeToolId !== "raster.blur" && activeToolId !== "raster.smudge" && activeToolId !== "raster.dodge" && activeToolId !== "raster.burn") {
      drawQuadraticStrokeSegment(current.working, state.width, state.height, current.curveStart, current.pending, current.pending, Number(options.size ?? 24), parseHexColor(current.target === "mask" && activeToolId === "raster.eraser" ? "#ffffff" : paintColor), opacity, current.target === "pixels" && activeToolId === "raster.eraser", brushMask, activeToolId === "raster.pencil" ? 1 : Number(options.hardness ?? 82) / 100, Number(options.spacing ?? 12) / 100, Number(options.roundness ?? 100) / 100, Number(options.angle ?? 0), options.pressureSize !== false, options.pressureOpacity === true);
    }
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    gesture.current = null;
    if (activeToolId && activeToolId !== "raster.patch") lastBrushPointRef.current = { toolId: activeToolId, layerId: current.target === "mask" ? `mask:${current.layerId}` : current.layerId, point: current.pending };
    const label = activeToolId === "raster.eraser" ? "Eraser (Ластик)" : activeToolId === "raster.pencil" ? "Pencil (Карандаш)" : activeToolId === "raster.highlighter" ? "Highlighter (Выделитель)" : activeToolId === "raster.clone" ? "Clone (Штамп)" : activeToolId === "raster.patch" ? "Patch (Заплатка)" : activeToolId === "raster.blur" ? "Blur (Размытие)" : activeToolId === "raster.smudge" ? "Smudge (Палец)" : activeToolId === "raster.dodge" ? "Dodge (Осветлитель)" : activeToolId === "raster.burn" ? "Burn (Затемнитель)" : "Brush Stroke (Мазок кисти)";
    void commitPixels(current.before, current.working, current.target === "mask" ? "Paint Layer Mask (Рисование по маске слоя)" : label, current.target, current.layerId, current.strokeBounds ?? null);
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
  const draftKind = selectionGesture.current?.kind;
  const displayedSelection = transformPreview?.selection ?? state.selection;
  const transformBounds = transformPreview ? (transformPreview.text?.targetBounds ?? displayedSelection?.bounds ?? alphaBounds(transformPreview.pixels, state.width, state.height)) : null;
  // Cmd/Ctrl+H hides the marching ants without dropping the selection, so an
  // edge can be judged without the animation crawling over it.
  const committedSelectionPath = displayedSelection && !selectionEdgesHidden ? selectionOutlinePath(displayedSelection.mask, state.width, state.height) : "";
  const brushLike = activeToolId === "raster.brush" || activeToolId === "raster.pencil" || activeToolId === "raster.highlighter" || activeToolId === "raster.eraser" || activeToolId === "raster.clone" || activeToolId === "raster.spotHeal" || activeToolId === "raster.blur" || activeToolId === "raster.smudge" || activeToolId === "raster.dodge" || activeToolId === "raster.burn";
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
    const point = pointFromNativeEvent(workspaceRef.current, viewport, state.width, state.height, event.nativeEvent);
    brushCursorRef.current.setAttribute("transform", `translate(${point.x} ${point.y}) rotate(${tipAngle})`);
    brushCursorRef.current.style.opacity = "1";
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
  return <div ref={workspaceRef} className="raster-workspace" data-active-tool={activeToolId} data-pixel-zoom={viewport.zoom >= 1 || undefined} data-space-held={spaceHeld || undefined} data-navigating={navigating || undefined} onPointerDownCapture={beginNavigation} onPointerMoveCapture={moveNavigation} onPointerUpCapture={endNavigation} onPointerCancelCapture={endNavigation} onWheel={handleWheel}>
    <div className="raster-stage" style={stageStyle}>
      <canvas ref={canvasRef} className={brushLike ? "brush-cursor-canvas" : ""} width={state.width} height={state.height} onPointerEnter={updateBrushCursor} onPointerLeave={() => { if (brushCursorRef.current) brushCursorRef.current.style.opacity = "0"; }} onPointerDown={handlePointerDown} onPointerMove={(event) => { updateBrushCursor(event); handlePointerMove(event); }} onPointerUp={finishGesture} onPointerCancel={finishGesture} onContextMenu={(event) => { event.preventDefault(); if (!brushLike) return; const rect = workspaceRef.current?.getBoundingClientRect(); if (rect) setBrushPopup({ left: Math.min(event.clientX - rect.left, rect.width - 300), top: Math.min(event.clientY - rect.top, rect.height - 430), detailed: false }); }} />
      {transformPreview?.text && <canvas
        ref={textTransformCanvasRef}
        className="text-transform-preview"
        style={{ left: transformPreview.text.targetBounds.x, top: transformPreview.text.targetBounds.y, width: transformPreview.text.targetBounds.width, height: transformPreview.text.targetBounds.height, transform: `rotate(${transformPreview.rotation}deg)` }}
      />}
      {preferences.showGuides && <svg className="guide-overlay" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true">{[...guides, ...(guideDraft ? [guideDraft] : [])].map((guide, index) => guide.orientation === "vertical" ? <line key={`${guide.orientation}-${index}`} x1={guide.position} y1="0" x2={guide.position} y2={state.height}/> : <line key={`${guide.orientation}-${index}`} x1="0" y1={guide.position} x2={state.width} y2={guide.position}/>)}</svg>}
      {brushLike && <svg className="brush-cursor-overlay" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><g ref={brushCursorRef} style={{ opacity: 0 }}>{preciseCursor ? <><path className="cursor-dark" d={`M${-7 / viewport.zoom} 0H${7 / viewport.zoom}M0 ${-7 / viewport.zoom}V${7 / viewport.zoom}`}/><path className="cursor-light" d={`M${-6 / viewport.zoom} 0H${6 / viewport.zoom}M0 ${-6 / viewport.zoom}V${6 / viewport.zoom}`}/></> : <><ellipse className="cursor-dark" rx={Number(brushOptions.size ?? 24) / 2} ry={Number(brushOptions.size ?? 24) * tipRoundness / 200}/><ellipse className="cursor-light" rx={Number(brushOptions.size ?? 24) / 2} ry={Number(brushOptions.size ?? 24) * tipRoundness / 200}/></>}</g></svg>}
      {selectionRect && selectionRect.width > 0 && selectionRect.height > 0 && <svg className="selection-overlay" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true">
        {draftKind === "lasso" ? <polyline points={lassoDraft.map((point) => `${point.x},${point.y}`).join(" ")} /> : draftKind === "ellipse" ? <ellipse cx={selectionRect.x + selectionRect.width / 2} cy={selectionRect.y + selectionRect.height / 2} rx={selectionRect.width / 2} ry={selectionRect.height / 2} /> : <rect x={selectionRect.x} y={selectionRect.y} width={selectionRect.width} height={selectionRect.height} />}
      </svg>}
      {shapeDraft && (Math.abs(shapeDraft.width) > 0 || Math.abs(shapeDraft.height) > 0) && (() => {
        const box = { x: Math.min(shapeDraft.x, shapeDraft.x + shapeDraft.width), y: Math.min(shapeDraft.y, shapeDraft.y + shapeDraft.height), width: Math.abs(shapeDraft.width), height: Math.abs(shapeDraft.height) };
        const kind = String(toolOptions["raster.shape"]?.shapeKind ?? "rectangle");
        return <svg className="shape-draft" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true">
          {kind === "ellipse"
            ? <ellipse cx={box.x + box.width / 2} cy={box.y + box.height / 2} rx={box.width / 2} ry={box.height / 2} />
            : kind === "line"
              ? <line x1={shapeDraft.x} y1={shapeDraft.y} x2={shapeDraft.x + shapeDraft.width} y2={shapeDraft.y + shapeDraft.height} />
              : <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={kind === "roundedRectangle" ? Number(toolOptions["raster.shape"]?.cornerRadius ?? 16) : 0} />}
        </svg>;
      })()}
      {!selectionDraft && committedSelectionPath && <svg className="selection-overlay committed-selection" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><path className="selection-soft-edge" d={committedSelectionPath} /><path className="selection-hard-edge" d={committedSelectionPath} /></svg>}
      {transformPreview && transformBounds && <svg className="transform-controls" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><rect x={transformBounds.x} y={transformBounds.y} width={transformBounds.width} height={transformBounds.height}/><line className="transform-rotation-stem" x1={transformBounds.x + transformBounds.width / 2} y1={transformBounds.y} x2={transformBounds.x + transformBounds.width / 2} y2={transformBounds.y - 27 / viewport.zoom}/><circle className="transform-rotation-handle" cx={transformBounds.x + transformBounds.width / 2} cy={transformBounds.y - 27 / viewport.zoom} r={5 / viewport.zoom}/>{([[0,0],[.5,0],[1,0],[0,.5],[1,.5],[0,1],[.5,1],[1,1]] as [number, number][]).map(([x,y], index) => <rect className="transform-handle" key={index} x={transformBounds.x + transformBounds.width * x - 4 / viewport.zoom} y={transformBounds.y + transformBounds.height * y - 4 / viewport.zoom} width={8 / viewport.zoom} height={8 / viewport.zoom}/>)}</svg>}
      {textFrameDraft && <svg className="text-frame-draft" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><rect x={textFrameDraft.x} y={textFrameDraft.y} width={textFrameDraft.width} height={textFrameDraft.height}/></svg>}
      {textDraft && (() => {
        const existingLayer = textDraft.layerId ? state.layers.find((item) => item.id === textDraft.layerId) : null;
        const draftOptions = toolOptions["raster.text"] ?? {};
        const draftFont = existingLayer?.text?.fontFamily ?? String(draftOptions.fontFamily ?? "Arial");
        const draftSize = existingLayer?.text?.fontSize ?? Number(draftOptions.fontSize ?? 48);
        const draftColor = existingLayer?.text?.color ?? foregroundColor;
        const draftAlign = existingLayer?.text?.align ?? "left";
        const draftLineHeight = existingLayer?.text?.lineHeight ?? 1.2;
        const anchorX = textDraft.path ? Math.min(textDraft.path.start.x, textDraft.path.end.x) : textDraft.point.x;
        const anchorY = textDraft.path ? Math.min(textDraft.path.start.y, textDraft.path.end.y, textDraft.path.control.y) - draftSize : textDraft.point.y;
        const wysiwyg: CSSProperties = { left: anchorX, top: anchorY, width: textDraft.mode === "point" ? Math.max(160, Math.min(520, state.width - anchorX)) : Math.max(24, textDraft.boxWidth ?? 240), minHeight: textDraft.mode === "area" ? Math.max(24, textDraft.boxHeight ?? 96) : draftSize * draftLineHeight * 1.5, fontFamily: draftFont, fontSize: draftSize, color: draftColor, textAlign: draftAlign as CSSProperties["textAlign"], lineHeight: draftLineHeight, fontWeight: existingLayer?.text?.bold ? 700 : 400, fontStyle: existingLayer?.text?.italic ? "italic" : "normal", textDecoration: existingLayer?.text?.underline ? "underline" : "none" };
        return <><textarea className="canvas-text-entry" data-text-mode={textDraft.mode} autoFocus spellCheck={false} style={wysiwyg} value={textDraft.value} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })} onBlur={() => { if (textCancelRef.current) textCancelRef.current = false; else commitText(); }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); cancelText(); } if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitText(); } }} placeholder="Type (Введите текст)"/>{textDraft.path && <svg className="text-path-guide" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><path d={`M ${textDraft.path.start.x} ${textDraft.path.start.y} Q ${textDraft.path.control.x} ${textDraft.path.control.y} ${textDraft.path.end.x} ${textDraft.path.end.y}`}/></svg>}</>;
      })()}
    </div>
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
  </div>;
}
