import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  activeRasterLayer, appendLayer, clampRegionToDocument, cloneRasterState, layerAccepts, layerLockReason, layerOpaqueBounds, paintMask, pickLayerAt, compositeRasterDocument, compositeRasterRegion, DirtyRegion, RasterTileCache, floodFill,
  accumulateUniquePixelBytes, changedRenderRegion, confineToSelection, visitPixelBuffers, layerDocumentPixels, mipForZoom, setLayerPixels, isRasterDocumentState, layerRenderSignatures, selectionOutlinePath,
  unionRect, type LayerRenderSignature, type PixelSelection, type Point, type RasterDocumentState, type RasterGuide, type RasterLayer, type RasterRect, type SelectionCombineMode,
  RASTER_ASSET_MIME, decodeRasterAsset, encodeRasterAsset, isRasterAsset,
} from "@vravio/env-raster";
import { createBufferRevisionOperation, type AssetId, type VravioDocument } from "@vravio/kernel";
import { kernel } from "./kernel";
import { importModelAsLayer } from "./scene3d-commands";
import { rasterToolById } from "./environments/raster/tools/registry";
import type { PaintTarget, ToolContext, ToolPointer } from "./environments/raster/tools/types";
import { commitPending, empty as moveToolEmpty, enterQuadTransformMode, enterWarpTransformMode, pendingBounds, startPendingTransform, type MoveState, type QuadTransformMode } from "./environments/raster/tools/definitions/move";
import { defaultViewport, useShellStore, type DocumentViewport } from "./store";
import { beginBusy } from "./busy";
import { diagnostic } from "./diagnostics";
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

export function RasterWorkspace({ document }: { document: VravioDocument }) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const brushCursorRef = useRef<HTMLDivElement>(null);
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
  const tiles = useRef(new RasterTileCache({ tileSize: 256 }));
  const documentDirty = useRef(new DirtyRegion());
  /** What the visible canvas currently holds, so idle renders repaint nothing. */
  const painted = useRef<{ canvas: HTMLCanvasElement | null; revision: number; signatures?: readonly LayerRenderSignature[]; mip?: number }>({ canvas: null, revision: -1 });
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
  const setTool = useShellStore((shell) => shell.setTool);
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
  // Backs ToolContext.scheduleWork: one RAF-coalesced "run the latest fn" queue, generic across
  // whichever tool is calling it — a transform resample today, potentially another tool's own
  // expensive per-frame recompute later.
  const workFrameRef = useRef<number | null>(null);
  const pendingWorkRef = useRef<(() => void) | null>(null);
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
      resetViewportToFit: () => setViewport(document.id, { mode: "fit", panX: 0, panY: 0 }),
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
      selectedLayers,
      setSelectedLayers: (layerIds) => setSelectedLayers(document.id, [...layerIds]),
      scheduleWork: (fn) => {
        pendingWorkRef.current = fn;
        if (workFrameRef.current !== null) return;
        workFrameRef.current = requestAnimationFrame(() => {
          workFrameRef.current = null;
          const latest = pendingWorkRef.current;
          pendingWorkRef.current = null;
          latest?.();
        });
      },
    };
  };

  // Broadcasts the Move tool's pending transform to the options bar (X/Y/W/H/angle readout with
  // its own Commit/Cancel), which lives outside this component and has no other way to see it.
  useEffect(() => {
    const pending = (toolStates["raster.move"] as MoveState | undefined)?.pending;
    const bounds = pending ? pendingBounds(pending, state.width, state.height) : null;
    window.dispatchEvent(new CustomEvent("vravio-transform-state", { detail: pending && bounds ? { active: true, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, rotation: pending.rotation } : null }));
  }, [toolStates, state.width, state.height]);

  // Edit ▸ Free Transform (Ctrl+T): the one way to open a pending transform without a canvas
  // gesture, so it has to reach into the Move tool's own state from outside any pointer handler.
  useEffect(() => {
    const start = () => {
      if (activeToolId !== "raster.move") setTool(document.id, "raster.move");
      startPendingTransform(toolContextFor("raster.move", canvasRef.current) as ToolContext<MoveState>);
    };
    const withPending = (run: (context: ToolContext<MoveState>, pending: NonNullable<MoveState["pending"]>) => void) => {
      const context = toolContextFor("raster.move", canvasRef.current) as ToolContext<MoveState>;
      const pending = context.state.pending;
      if (pending) run(context, pending);
    };
    const commit = () => withPending((context, pending) => { commitPending(context, pending); context.setState(moveToolEmpty); });
    const cancel = () => withPending((context) => { context.setState(moveToolEmpty); context.previewWithLayerHidden(null); });
    window.addEventListener("vravio-transform-start", start); window.addEventListener("vravio-transform-commit", commit); window.addEventListener("vravio-transform-cancel", cancel);
    return () => { window.removeEventListener("vravio-transform-start", start); window.removeEventListener("vravio-transform-commit", commit); window.removeEventListener("vravio-transform-cancel", cancel); };
  });

  // Picking a different layer in the Layers panel (not a canvas click, which the Move tool
  // already handles via Auto-Select) leaves a transform pending on a layer that is no longer
  // active — committing it here matches the old behaviour of following the panel's own pick.
  useEffect(() => {
    const previous = previousActiveLayerId.current;
    previousActiveLayerId.current = state.activeLayerId;
    if (!previous || previous === state.activeLayerId) return;
    const context = toolContextFor("raster.move", canvasRef.current) as ToolContext<MoveState>;
    const pending = context.state.pending;
    if (pending?.layerId === previous) { commitPending(context, pending, state.activeLayerId); context.setState(moveToolEmpty); }
  }, [state.activeLayerId]);

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

    const layer = activeRasterLayer(state);
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
    // Locks are checked once, here, rather than in each tool: every tool below
    // this point either paints or moves, and a refusal has to be visible or the
    // user is left wondering why the canvas stopped responding.
    if (!maskTarget && activeToolId) {
      const action = activeToolId === "raster.eraser" ? "erase" : "paint";
      if (!layerAccepts(layer, action)) {
        diagnostic("info", "layer.locked", layerLockReason(layer, action) ?? "Layer is locked", { documentId: document.id, layerId: layer.id, tool: activeToolId });
        return;
      }
    }
    if (!maskTarget && activeToolId && layer.kind !== "pixel" && RASTER_ONLY_TOOLS.has(activeToolId)) {
      setRasterizeConfirm({ layerId: layer.id, layerName: layer.name });
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
  };

  const finishGesture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (catalogueTool?.onGestureEnd) {
      const pointer = toolPointerFrom(event);
      if (pointer) { catalogueTool.onGestureEnd(toolContextFor(catalogueTool.id, event.currentTarget), pointer); return; }
    }
  };

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
  const movePending = (toolStates["raster.move"] as MoveState | undefined)?.pending;
  const displayedSelection = catalogueMarqueePreview ?? movePending?.selection ?? state.selection;
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
    const context = toolContextFor("raster.move", canvasRef.current) as ToolContext<MoveState>;
    const pending = context.state.pending;
    if (activeToolId !== "raster.move" || !pending || pending.text) return;
    const bounds = pendingBounds(pending, state.width, state.height);
    if (!bounds) return;
    const currentMode = pending.corners ? String(toolOptions["raster.move"]?.transformMode ?? "distort") : pending.mesh ? "warp" : "free";
    const enterQuadMode = (mode: QuadTransformMode) => {
      setToolOption("raster.move", "transformMode", mode);
      context.setState({ pending: enterQuadTransformMode(pending, bounds), drag: null });
    };
    const enterWarp = () => {
      context.setState({ pending: enterWarpTransformMode(pending, bounds), drag: null });
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
      <canvas ref={canvasRef} className={brushLike ? "brush-cursor-canvas" : ""} width={state.width} height={state.height} onPointerEnter={updateBrushCursor} onPointerLeave={() => { if (brushCursorRef.current) brushCursorRef.current.style.opacity = "0"; setCloneSourceView(null); }} onPointerDown={handlePointerDown} onPointerMove={(event) => { updateBrushCursor(event); handlePointerMove(event); }} onPointerUp={finishGesture} onPointerCancel={finishGesture} onContextMenu={(event) => { if (selectionLike) { onSelectionContextMenu(event); return; } if (activeToolId === "raster.move" && (toolStates["raster.move"] as MoveState | undefined)?.pending) { onTransformContextMenu(event); return; } event.preventDefault(); if (!brushLike) return; const rect = workspaceRef.current?.getBoundingClientRect(); if (rect) setBrushPopup({ left: Math.min(event.clientX - rect.left, rect.width - 300), top: Math.min(event.clientY - rect.top, rect.height - 430), detailed: false }); }} />
      {preferences.showGuides && <svg className="guide-overlay" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true">{[...guides, ...(guideDraft ? [guideDraft] : [])].map((guide, index) => guide.orientation === "vertical" ? <line key={`${guide.orientation}-${index}`} x1={guide.position} y1="0" x2={guide.position} y2={state.height}/> : <line key={`${guide.orientation}-${index}`} x1="0" y1={guide.position} x2={state.width} y2={guide.position}/>)}</svg>}
      {/* Whatever the active catalogue tool draws over the canvas. */}
      {catalogueTool?.Overlay && <catalogueTool.Overlay state={toolStates[catalogueTool.id] ?? catalogueTool.createState()} document={state} options={(toolOptions[catalogueTool.id] ?? {}) as Readonly<Record<string, string | number | boolean>>} context={toolContextFor(catalogueTool.id, canvasRef.current)}/>}
      {committedSelectionPath && <svg className="selection-overlay committed-selection" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><path className="selection-soft-edge" d={committedSelectionPath} /><path className="selection-hard-edge" d={committedSelectionPath} /></svg>}
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
    {movePending && <div className="pending-transform-hint">Enter — Apply (Применить) · Esc — Cancel (Отменить)</div>}
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
