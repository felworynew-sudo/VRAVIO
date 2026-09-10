import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  activeRasterLayer, appendLayer, layerAccepts, layerLockReason, paintMask, pickLayerAt, compositeRasterDocument,
  layerDocumentPixels, isRasterDocumentState, selectionOutlinePath,
  unionRect, type PixelSelection, type Point, type RasterDocumentState, type RasterLayer, type RasterRect,
} from "@vravio/env-raster";
import type { VravioDocument } from "@vravio/kernel";
import { kernel } from "./kernel";
import { convertLayerToScene3D, importModelAsLayer, updateScene3DLayer } from "./scene3d-commands";
import { Scene3DOrbitGizmo } from "./Scene3DOrbitGizmo";
import { Scene3DGroundGizmo } from "./Scene3DGroundGizmo";
import { rasterToolById } from "./environments/raster/tools/registry";
import type { PaintTarget, ToolContext, ToolPointer } from "./environments/raster/tools/types";
import { applyWarpPreset, commitPending, empty as moveToolEmpty, pendingBounds, startPendingTransform, type MoveState } from "./environments/raster/tools/definitions/move";
import { defaultViewport, useShellStore, type DocumentViewport } from "./store";
import { beginBusy } from "./busy";
import { usePluginRuns } from "./plugins/usePluginRuns";
import type { RasterPluginDoor } from "./environments/raster/plugins/surface";
import { resolveLabel, text } from "./i18n";
import { confirmModal, errorModal } from "./modals/runtime";
import { rasterizeLayer } from "./raster-rasterize";
import { diagnostic } from "./diagnostics";
import { pointFromNativeEvent } from "./raster-coordinates";
import { maskToRgba, putPixels } from "./raster-pixel-buffers";
import { useCanvasNavigation } from "./raster-navigation";
import { useBrushCursor } from "./raster-brush-cursor";
import { useRasterRulerGuides } from "./raster-ruler-guides";
import { MarchingAnts } from "./marching-ants";
import { useRasterCommit } from "./raster-commit";
import { useRasterContextMenus } from "./raster-context-menus";
import { useContextMenu } from "./ContextMenu";
import { RasterBrushTipPopup } from "./RasterBrushTipPopup";

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

export function RasterWorkspace({ document }: { document: VravioDocument }) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The element every canvas gesture is received and captured on — see its own comment in the
   * render below. */
  const pointerFieldRef = useRef<HTMLDivElement>(null);
  const previousActiveLayerId = useRef<string | null>(null);
  const sourcePointRef = useRef<{ x: number; y: number } | null>(null);
  const cloneOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const lastBrushPointRef = useRef<{ toolId: string; layerId: string; point: Point } | null>(null);
  const [brushPopup, setBrushPopup] = useState<{ left: number; top: number; detailed: boolean } | null>(null);
  const [preciseCursor, setPreciseCursor] = useState(false);
  // A tool-provided cursor hint (`RasterToolDefinition.cursorFor`) — mirrors `VectorWorkspace`'s
  // own `dynamicCursor`, added there first for `vector.pen`. `undefined` means "no hint right
  // now", which the canvas's own inline `style` below simply omits, falling back to
  // `styles.css`'s static `.raster-stage canvas{cursor:crosshair}` rule (or whichever
  // `data-active-tool` rule already overrides it, e.g. the hand tool's `grab`).
  const [dynamicCursor, setDynamicCursor] = useState<string | undefined>(undefined);
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
  const { navigating, spaceHeld, workspaceSize, beginNavigation, moveNavigation, endNavigation, handleWheel } = useCanvasNavigation({ documentId: document.id, workspaceRef, viewport, activeToolId, toolOptions, documentWidth: state.width, documentHeight: state.height });
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
  const { renderWorking, renderWorkingMultiple, renderWorkingRegion, renderSpotHealOverlay, renderSelectionBrushOverlay, commitPixels, commitDocumentState, commitSelection } = useRasterCommit({ document, state, viewport, canvasRef, canvasPixels });

  // CapsLock toggles the precise (crosshair) cursor instead of the ring —
  // Photoshop's own shortcut. Space-bar navigation and its Photoshop zoom
  // modifiers live in useCanvasNavigation, a separate listener on the same
  // two events; the two never interact, since they key off disjoint
  // `event.code`s.
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === "INPUT" || target?.tagName === "SELECT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (event.code === "CapsLock" && !editing) { event.preventDefault(); setPreciseCursor((current) => !current); }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, []);

  /**
   * Offers to turn a text or adjustment layer into pixels, and does it if the
   * user agrees.
   *
   * The question is asked through the modal catalogue by id
   * (`confirmModal` → "confirm"), so this no longer needs a piece of state
   * holding "a dialog is open, and here is what to do when it is answered",
   * nor a dialog component of its own to import — the whole point of stage 7's
   * `modals/`. The *decision* of when to ask still lives here, since it
   * depends on which tool is active and what layer it is about to touch.
   */
  const offerRasterize = async (layerId: string, layerName: string) => {
    const confirmed = await confirmModal({
      title: text(language, "This tool needs pixels", "Этому инструменту нужны пиксели"),
      message: text(
        language,
        `"${layerName}" is a text layer and has no pixels to edit yet. Rasterize it into a normal pixel layer first?`,
        `Слой «${layerName}» — текстовый, у него ещё нет пикселей для редактирования. Растрировать его в обычный слой с пикселями?`,
      ),
      confirmLabel: text(language, "Rasterize Layer", "Растрировать слой"),
    });
    if (!confirmed) return;

    const done = beginBusy("Rasterising layer (Растеризация слоя)");
    try { await rasterizeLayer(document.id, layerId); } finally { done(); }
  };

  /**
   * The bridge to the tool catalogue (stage 3 of docs/migration-plan.md).
   *
   * Every raster tool has a file under `environments/raster/tools/definitions/`
   * and runs through its hooks — the old `activeToolId === "…"` switch this
   * bridge coexisted with during stage 5's rollout is gone (`raster.move`
   * was the last tool on it). This lookup, and `toolContextFor` below, are
   * what remain of the bridge now that there is nothing left to fall back to.
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
  // The same RAF-coalescing as previewFrameRef, kept as its own ref rather than folded into it:
  // a linked-layer group drag (raster.move) previews several layers' buffers as one composite,
  // a different shape of work than previewFrameRef's single {target,layerId,working} slot, and
  // the two never fire in the same gesture.
  const previewLayersFrameRef = useRef<{ frame: number | null; layers: readonly { layerId: string; pixels: Uint8ClampedArray }[] } | null>(null);
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

  const toolPointerFrom = (event: React.PointerEvent<HTMLElement>): ToolPointer | null => {
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
      // Captured on the pointer field, which is the element that actually receives the gesture.
      // Capturing on the canvas is what it used to do, and once the canvas stopped taking pointer
      // events (see the field's own comment) that quietly swallowed every drag: capture retargets
      // all further events to the captured element, so they were delivered to something that
      // cannot receive them — no move, no up, nothing committed. Caught live, with a brush stroke
      // that painted on screen and left the document at revision 0.
      capturePointer: (pointerId) => pointerFieldRef.current?.setPointerCapture(pointerId),
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
          // A mask takes the region path too now. It used to fall through to the full path —
          // documented here as a cosmetic quirk, but it was also the reason painting on a mask
          // stuttered where painting on a layer did not: the full path converts the whole
          // working buffer back to a mask and composites the entire document, every frame.
          if (region) renderWorkingRegion(entry.working, region, entry.target, entry.layerId);
          else renderWorking(entry.working, entry.target, entry.layerId);
        });
      },
      schedulePreviewLayers: (layers) => {
        const current = previewLayersFrameRef.current;
        if (current) { current.layers = layers; if (current.frame !== null) return; }
        const entry = current ?? { frame: null, layers };
        previewLayersFrameRef.current = entry;
        entry.frame = requestAnimationFrame(() => {
          entry.frame = null;
          renderWorkingMultiple(entry.layers);
        });
      },
      commit: (before, after, label, target = paintTarget.kind, layerId = paintTarget.layerId, bounds = null) => commitPixels(before, after, label, target, layerId, bounds),
      commitSelection: (before, after, label) => commitSelection(before, after, label),
      commitDocument: (before, after, label, bounds) => commitDocumentState(before, after, label, bounds),
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
      previewSelectionBrushMask: (mask, originX, originY, width, height) => renderSelectionBrushOverlay(mask, originX, originY, width, height),
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
    window.dispatchEvent(new CustomEvent("vravio-transform-state", { detail: pending && bounds ? { active: true, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, rotation: pending.rotation, warp: Boolean(pending.mesh) } : null }));
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
    // The warp-style dropdown in the options bar (Photoshop keeps it there while a Warp is
    // open). Same shape as Free Transform above: the bar lives outside this component, so the
    // only way into the tool's own state is a freshly built context.
    const preset = (event: Event) => withPending((context, pending) => {
      const { style, bend, vertical } = (event as CustomEvent<{ style: string; bend: number; vertical: boolean }>).detail;
      const bounds = pendingBounds(pending, state.width, state.height);
      if (!bounds || pending.text) return;
      const next = applyWarpPreset(pending, bounds, state.width, state.height, style as never, bend, vertical);
      context.setState({ pending: next, drag: null });
      context.schedulePreview(next.pixels, "pixels", next.layerId);
    });
    const cancel = () => withPending((context) => { context.setState(moveToolEmpty); context.previewWithLayerHidden(null); });
    window.addEventListener("vravio-transform-start", start); window.addEventListener("vravio-transform-commit", commit); window.addEventListener("vravio-transform-cancel", cancel); window.addEventListener("vravio-warp-preset", preset);
    return () => { window.removeEventListener("vravio-transform-start", start); window.removeEventListener("vravio-transform-commit", commit); window.removeEventListener("vravio-transform-cancel", cancel); window.removeEventListener("vravio-warp-preset", preset); };
  });

  /**
   * Everything raster contributes to running a plugin: its own door.
   *
   * A plugin's result reaches the document through `commitPixels` — the same
   * door every tool uses — so the rules engine applies to it without a branch
   * of its own: the selection confines it, a locked layer refuses it, a text
   * layer refuses it. That is section 4.7's "правила применяются к плагину
   * автоматически", and it is only true if the plugin uses the real door.
   * `applyFilter` in the shell is not that door: it re-implements selection
   * confinement itself and knows nothing about the locks.
   *
   * The run itself — refusal, permissions, worker, validation — is
   * `usePluginRuns`, shared with every other environment, and
   * `environments/raster/plugins/surface.ts` is the only place that still knows
   * a raster payload is pixels.
   */
  const pluginLayer = activeRasterLayer(state);
  usePluginRuns("raster", state, { layerId: pluginLayer.id, before: canvasPixels(pluginLayer), commitPixels } satisfies RasterPluginDoor);

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
    // Every other `toolContextFor` call site below wires the live canvas —
    // this was the one exception, passing `null` unconditionally. Nothing
    // exposed it before: no other tool's own `onDeactivate` reached for
    // `context.previewWithLayerHidden` (raster.move's routes cleanup through
    // an actual document commit instead, which repaints via the ordinary
    // revision-watching effect). raster.selectionBrush's own `onDeactivate`
    // is the first to call it directly — found live, as a translucent wash
    // left stuck on screen after switching away from the tool, no matter how
    // many times `previewWithLayerHidden(null)` ran: it was a no-op the whole
    // time, `if (!canvas) return;` swallowing it silently.
    leaving?.onDeactivate?.(toolContextFor(previous, canvasRef.current));
    // A cursor hint from the tool being left must not linger on the one just switched to — it
    // will set its own on the next pointer move, but there is a gap (right after switching,
    // before the pointer moves again) that would otherwise still show the old tool's hint.
    setDynamicCursor(undefined);
  });

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button === 2) return;
    const canvas = canvasRef.current;
    if (!workspaceRef.current) return;

    const layer = activeRasterLayer(state);
    const maskTarget = editingMaskLayer?.id === state.activeLayerId ? editingMaskLayer : null;

    if (catalogueTool?.onPointerDown) {
      // Same gate RASTER_ONLY_TOOLS enforced for the switch below: a tool
      // that needs real pixels to write into is not allowed to write into a
      // text or adjustment layer's cached preview — that would desync it
      // from the data it is actually drawn from silently. Editing a mask is
      // always pixels regardless of the layer's own kind, which is why
      // maskTarget exempts it.
      if (!maskTarget && catalogueTool.requiresRasterized && layer.kind !== "pixel") {
        void offerRasterize(layer.id, layer.name);
        return;
      }
      const pointer = toolPointerFrom(event);
      if (pointer) { catalogueTool.onPointerDown(toolContextFor(catalogueTool.id, canvas), pointer); return; }
    }
    // The lock check for every tool that has not moved into the catalogue yet:
    // the dispatch above returns before this line, so a catalogue tool never
    // reaches it and asks `locksRefuse` for itself instead (tools/lock-guard.ts
    // — which is where the reasoning lives, including why the rules rather than
    // this are the actual enforcement). This used to read "checked once, here,
    // rather than in each tool", which stopped being true the moment the first
    // tool moved above it. A refusal still has to be visible either way, or the
    // user is left wondering why the canvas stopped responding.
    if (!maskTarget && activeToolId) {
      const action = activeToolId === "raster.eraser" ? "erase" : "paint";
      if (!layerAccepts(layer, action)) {
        diagnostic("info", "layer.locked", layerLockReason(layer, action) ?? "Layer is locked", { documentId: document.id, layerId: layer.id, tool: activeToolId });
        return;
      }
    }
    if (!maskTarget && activeToolId && layer.kind !== "pixel" && RASTER_ONLY_TOOLS.has(activeToolId)) {
      void offerRasterize(layer.id, layer.name);
      return;
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!catalogueTool) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    const context = toolContextFor(catalogueTool.id, canvasRef.current);
    let lastPointer: ToolPointer | undefined;
    if (catalogueTool.onPointerMove) {
      // Coalesced samples, not just the one event React handed over: a
      // fast stroke can move the pointer several pixels between the
      // browser's own paint frames, and using only the latest sample is
      // what RASTER-PAINT-002 already found leaves gaps in a fast stroke.
      // The context is built once and reused across all of them — its
      // closures do not depend on which sample is current, only `pointer`
      // does, and toolContextFor is not free to call per sample.
      for (const native of event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]) {
        lastPointer = toolPointerFromNative(native, workspace, rect);
        catalogueTool.onPointerMove(context, lastPointer);
      }
    }
    // Cursor hint only needs the final position, not every coalesced sample — it is a hover
    // preview of a hit-test, not a gesture that has to track the pointer's whole path. Always
    // set, even to `undefined`, so switching to a tool without a hint (or moving off a handle)
    // actually clears whatever the previous tool or hover position left behind.
    setDynamicCursor(catalogueTool.cursorFor?.(context, lastPointer ?? toolPointerFromNative(event.nativeEvent, workspace, rect)));
  };

  const finishGesture = (event: React.PointerEvent<HTMLElement>) => {
    if (catalogueTool?.onGestureEnd) {
      const pointer = toolPointerFrom(event);
      if (pointer) { catalogueTool.onGestureEnd(toolContextFor(catalogueTool.id, canvasRef.current), pointer); return; }
    }
  };

  const stageStyle = { width: state.width, height: state.height, transform: `translate(-50%, -50%) translate(${viewport.panX}px, ${viewport.panY}px) rotate(${viewport.rotation}deg) scale(${viewport.zoom})` } as CSSProperties;
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
  // edge can be judged without the animation crawling over it. The Selection
  // Brush hides them the same way, but for a different reason and only while
  // it is the active tool: it draws its own Quick-Mask-style translucent wash
  // over the selection instead (see selection-brush.tsx's own Overlay), and
  // this baseline ants outline sitting underneath a raster tint read as two
  // disagreeing representations of the same selection at once.
  const committedSelectionPath = displayedSelection && !selectionEdgesHidden && activeToolId !== "raster.selectionBrush" ? selectionOutlinePath(displayedSelection.mask, state.width, state.height) : "";
  const brushLike = activeToolId === "raster.brush" || activeToolId === "raster.pencil" || activeToolId === "raster.highlighter" || activeToolId === "raster.eraser" || activeToolId === "raster.clone" || activeToolId === "raster.spotHeal" || activeToolId === "raster.blur" || activeToolId === "raster.smudge" || activeToolId === "raster.dodge" || activeToolId === "raster.burn";
  const selectionLike = activeToolId === "raster.marquee" || activeToolId === "raster.ellipseMarquee" || activeToolId === "raster.lasso";
  const activeLayer3D = activeRasterLayer(state)?.kind === "3d" ? activeRasterLayer(state) ?? null : null;
  const { selectionContextMenu, transformContextMenu, onSelectionContextMenu, onTransformContextMenu } = useRasterContextMenus({
    activeToolId, toolOptions, setToolOption, language, state, toolContextFor, canvas: canvasRef.current, selectionLike,
  });
  // "Convert to 3D" / "Harmonize with Scene" on canvas — the owner's own
  // request that both reach the layer whether right-clicked in the Layers
  // panel (DockLayout.tsx's own menu) or right here. Deliberately its own
  // small menu rather than folding into `layerContextMenu`: that builder
  // lives inside DockLayout.tsx's closures (deleteLayer, addGroup,
  // applyMask, a dozen others), all scoped to state that component owns —
  // pulling it out for two shared entries would be a much larger refactor
  // than the actions themselves need.
  const scene3dMenu = useContextMenu();
  const activeLayerForConvert = activeRasterLayer(state);
  const canConvertToScene3D = activeLayerForConvert && (activeLayerForConvert.kind === "text" || activeLayerForConvert.kind === "pixel" || activeLayerForConvert.kind === "shape");
  // Gates "Rotate 3D Object" / "Cast Shadow…" below — Harmonize used to sit in this same
  // menu (`canHarmonize`) but moved to Изображение ▸ Коррекция ▸ Быстрая гармонизация, which
  // works on any layer rather than only a 3D one, so it no longer belongs behind this gate.
  const is3DLayer = activeLayerForConvert?.kind === "3d";
  // "Rotate 3D Object" — the owner tried the always-on linear-slider gizmo
  // live and asked for it to come off. Now nothing shows until this is
  // chosen from the layer's own menu, and it closes itself the moment the
  // active layer or tool stops being the one it was opened for (below) —
  // the same "a pending edit does not survive switching away from it"
  // contract `move.tsx`'s own transform frame already keeps.
  const orbitGizmoLayerId = useShellStore((shell) => shell.scene3dOrbitLayerIdByDocument[document.id] ?? null);
  const setScene3DOrbitLayer = useShellStore((shell) => shell.setScene3DOrbitLayer);
  // "Cast Shadow" — the ground-plane tilt/distance sliders (Scene3DGroundGizmo.tsx). Mutually
  // exclusive with the orbit gizmo above (opening one closes the other, in the menu handler
  // below): both are full-canvas live-render overlays for the same layer, and showing both at
  // once would mean two persistent THREE sessions fighting over the same visible pixels.
  const groundGizmoLayerId = useShellStore((shell) => shell.scene3dGroundLayerIdByDocument[document.id] ?? null);
  const setScene3DGroundLayer = useShellStore((shell) => shell.setScene3DGroundLayer);
  // The orbit gizmo's own pending rotation — a ref, not state, since it is written on every drag
  // tick (`onOrbitLiveChange`, forwarded to the options bar's live X/Y/Z readout through a window
  // event the same way `vravio-transform-state` already broadcasts the 2D pending transform) and
  // only ever *read* imperatively, at the one moment a commit actually happens.
  const pendingOrbitRotationRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const onOrbitLiveChange = (rotation: { x: number; y: number; z: number }) => {
    pendingOrbitRotationRef.current = rotation;
    window.dispatchEvent(new CustomEvent("vravio-scene3d-transform-state", { detail: { active: true, rotationX: rotation.x, rotationY: rotation.y, rotationZ: rotation.z } }));
  };
  // The gizmo's one door for ending a session, committed or not — used by Enter/the options bar's
  // own ✓ button *and* by the "switched away" effect below, so "click elsewhere saves" (the
  // owner's own request, matching Free Transform's own "click outside the frame commits" habit)
  // and an explicit Commit button are the same code path, not two.
  const commitOrbitGizmo = async () => {
    const rotation = pendingOrbitRotationRef.current, layerId = orbitGizmoLayerId;
    pendingOrbitRotationRef.current = null;
    // Awaited before closing: `updateScene3DLayer` re-renders the layer's own baked pixels, and
    // closing the gizmo restores that layer's ordinary visibility (see the hide/restore effect
    // below) — closing first would flash the *old*, pre-rotation pixels for a frame while the new
    // render is still in flight.
    if (layerId && rotation) await updateScene3DLayer(document.id, layerId, { rotationX: rotation.x, rotationY: rotation.y, rotationZ: rotation.z });
    setScene3DOrbitLayer(document.id, null);
  };
  const cancelOrbitGizmo = () => {
    pendingOrbitRotationRef.current = null;
    setScene3DOrbitLayer(document.id, null);
  };
  // Nothing in the document changes while the gizmo drags — only its own live Three.js session
  // does — so the layer's own last-committed pixels would otherwise still show underneath that
  // live overlay for the whole gesture: the reported "object visually duplicates while rotating"
  // bug. Hidden for the whole visit (not just mid-drag) and restored the moment it ends, whichever
  // way (commit, cancel, or the "switched away" effect below) — one effect, so there is no path
  // that hides the layer without a matching path that un-hides it again.
  useEffect(() => {
    if (!orbitGizmoLayerId) return;
    const context = toolContextFor("raster.move", canvasRef.current) as ToolContext<MoveState>;
    context.previewWithLayerHidden(orbitGizmoLayerId);
    return () => {
      context.previewWithLayerHidden(null);
      window.dispatchEvent(new CustomEvent("vravio-scene3d-transform-state", { detail: null }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbitGizmoLayerId]);
  // The options bar's own ✓/× buttons live in App.tsx, outside this component — reached the same
  // way the 2D pending transform's own commit/cancel buttons already are, through a window event.
  useEffect(() => {
    const commit = () => void commitOrbitGizmo();
    const cancel = () => cancelOrbitGizmo();
    window.addEventListener("vravio-scene3d-transform-commit", commit);
    window.addEventListener("vravio-scene3d-transform-cancel", cancel);
    return () => { window.removeEventListener("vravio-scene3d-transform-commit", commit); window.removeEventListener("vravio-scene3d-transform-cancel", cancel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbitGizmoLayerId]);
  useEffect(() => {
    // The orbit gizmo now commits instead of silently discarding on "switched away" — the same
    // request that gave it the options-bar Commit/Cancel pair below: losing an in-progress
    // rotation because the active tool or layer happened to change out from under it (a document
    // update elsewhere, a stray re-render) is exactly what made it read as "the gizmo just
    // disappears, cause unclear" rather than a deliberate close.
    if (orbitGizmoLayerId && (activeToolId !== "raster.move" || activeLayer3D?.id !== orbitGizmoLayerId)) void commitOrbitGizmo();
    if (groundGizmoLayerId && (activeToolId !== "raster.move" || activeLayer3D?.id !== groundGizmoLayerId)) setScene3DGroundLayer(document.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbitGizmoLayerId, groundGizmoLayerId, activeToolId, activeLayer3D?.id, document.id]);
  const documentOriginX = workspaceSize.width / 2 + viewport.panX - state.width * viewport.zoom / 2, documentOriginY = workspaceSize.height / 2 + viewport.panY - state.height * viewport.zoom / 2;
  const { updateBrushCursor, onPointerLeave: onBrushCursorLeave, brushOptions, tipRoundness, overlay: brushCursorOverlay } = useBrushCursor({
    state, viewport, toolOptions, activeToolId, brushLike, canvasPixels, workspaceRef, sourcePointRef, cloneOffsetRef, preciseCursor, documentOriginX, documentOriginY,
  });
  const { guideOverlay, rulers } = useRasterRulerGuides({ documentId: document.id, state, viewport, workspaceRef, workspaceSize, documentOriginX, documentOriginY });
  const onDropModel = (event: React.DragEvent<HTMLDivElement>) => {
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => /\.(obj|glb|gltf)$/i.test(file.name));
    if (!files.length) return;
    event.preventDefault();
    files.forEach((file) => void importModelAsLayer(document.id, file));
  };

  return <div ref={workspaceRef} className="raster-workspace" data-active-tool={activeToolId} data-pixel-zoom={viewport.zoom >= 1 || undefined} data-space-held={spaceHeld || undefined} data-navigating={navigating || undefined} onPointerDownCapture={beginNavigation} onPointerMoveCapture={moveNavigation} onPointerUpCapture={endNavigation} onPointerCancelCapture={endNavigation} onWheel={handleWheel} onDragOver={(event) => { if ([...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={onDropModel}>
    {/*
      The pointer field: every canvas gesture is received here, not on the <canvas> itself.

      The canvas element is exactly the document's size, so anything the user has to reach
      *outside* the artwork was simply unreachable — no element there, no events. The owner
      found it on the transform frame: a layer that fits the canvas exactly puts its corner
      handles on the canvas corners, which leaves the rotate ring (a few screen pixels further
      out) hanging over nothing, so such a layer could not be rotated at all. Scaling outward
      from an edge handle had the same hole, and so did starting a marquee or a stroke just
      off the artwork and dragging in — all of which Photoshop allows, because in Photoshop the
      *document window* takes the gesture, not the page.

      So the field spans the workspace and the canvas is `pointer-events: none`. It sits before
      the stage in document order, which puts it underneath everything that draws — rulers and
      guides keep their own handlers and still win, and the live text editor inside the stage
      keeps receiving its own events, because only the canvas gives up pointer events, not the
      stage. Coordinates never had to change: `pointFromNativeEvent` has always measured from
      the workspace element, so a point past the canvas edge already came out as the document
      coordinate it is (negative, or past the width) rather than being clamped or lost.
    */}
    <div ref={pointerFieldRef} className="raster-pointer-field" style={dynamicCursor ? { cursor: dynamicCursor } : undefined} onPointerEnter={updateBrushCursor} onPointerLeave={() => { onBrushCursorLeave(); setDynamicCursor(undefined); }} onPointerDown={handlePointerDown} onPointerMove={(event) => { updateBrushCursor(event); handlePointerMove(event); }} onPointerUp={finishGesture} onPointerCancel={finishGesture} onContextMenu={(event) => { if (selectionLike) { onSelectionContextMenu(event); return; } if (activeToolId === "raster.move" && (toolStates["raster.move"] as MoveState | undefined)?.pending) { onTransformContextMenu(event); return; } if (activeToolId === "raster.move" && (canConvertToScene3D || is3DLayer) && activeLayerForConvert) { scene3dMenu.open(event, [...(canConvertToScene3D ? [{ label: text(language, "Convert to 3D", "Преобразовать в 3D"), onSelect: () => void convertLayerToScene3D(document.id, activeLayerForConvert.id) }] : []), ...(is3DLayer ? [{ label: text(language, "Rotate 3D Object", "Повернуть 3D объект"), onSelect: () => { setScene3DGroundLayer(document.id, null); setScene3DOrbitLayer(document.id, activeLayerForConvert.id); } }, { label: text(language, "Cast Shadow…", "Настроить тень…"), onSelect: () => { setScene3DOrbitLayer(document.id, null); setScene3DGroundLayer(document.id, activeLayerForConvert.id); } }] : [])]); return; } event.preventDefault(); if (!brushLike) return; const rect = workspaceRef.current?.getBoundingClientRect(); if (rect) setBrushPopup({ left: Math.min(event.clientX - rect.left, rect.width - 300), top: Math.min(event.clientY - rect.top, rect.height - 430), detailed: false }); }} />
    <div className="raster-stage" style={stageStyle}>
      <canvas ref={canvasRef} className={brushLike ? "brush-cursor-canvas" : ""} width={state.width} height={state.height} />
      {/* Whatever the active catalogue tool draws over the canvas. */}
      {catalogueTool?.Overlay && <catalogueTool.Overlay state={toolStates[catalogueTool.id] ?? catalogueTool.createState()} document={state} options={(toolOptions[catalogueTool.id] ?? {}) as Readonly<Record<string, string | number | boolean>>} context={toolContextFor(catalogueTool.id, canvasRef.current)}/>}
      {committedSelectionPath && <svg className="selection-overlay committed-selection" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><MarchingAnts zoom={viewport.zoom}><path d={committedSelectionPath} /></MarchingAnts></svg>}
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
    {catalogueTool?.ScreenOverlay && <catalogueTool.ScreenOverlay state={toolStates[catalogueTool.id] ?? catalogueTool.createState()} document={state} options={(toolOptions[catalogueTool.id] ?? {}) as Readonly<Record<string, string | number | boolean>>} context={toolContextFor(catalogueTool.id, canvasRef.current)}/>}
    {brushCursorOverlay}
    {/*
      Scene3DOrbitGizmo: Blender-style rotation manipulators for a 3D layer
      (docs/master-plan.md §8.9's own TODO — "ручки вращения модели...
      прямо на слое, не только в панели Свойства") — entered explicitly via
      "Rotate 3D Object" on the layer's own context menu, not shown by
      default (the owner tried the earlier always-on linear-slider version
      live and asked for it to come off).
    */}
    {activeToolId === "raster.move" && activeLayer3D && orbitGizmoLayerId === activeLayer3D.id && <Scene3DOrbitGizmo documentId={document.id} document={state} layer={activeLayer3D} zoom={viewport.zoom} documentOriginX={documentOriginX} documentOriginY={documentOriginY} onLiveChange={onOrbitLiveChange} onAccept={() => void commitOrbitGizmo()} onCancel={cancelOrbitGizmo}/>}
    {/* Scene3DGroundGizmo: the ground-plane tilt/distance sliders for "Cast Shadow" — same entry door as the orbit gizmo above, mutually exclusive with it. */}
    {activeToolId === "raster.move" && activeLayer3D && groundGizmoLayerId === activeLayer3D.id && <Scene3DGroundGizmo documentId={document.id} document={state} layer={activeLayer3D} zoom={viewport.zoom} documentOriginX={documentOriginX} documentOriginY={documentOriginY} onClose={() => setScene3DGroundLayer(document.id, null)}/>}
    {preferences.showGuides && guideOverlay}
    {preferences.showRulers && rulers}
    {brushPopup && brushLike && activeToolId && <RasterBrushTipPopup activeToolId={activeToolId} brushOptions={brushOptions} position={brushPopup} detailed={brushPopup.detailed} onToggleDetailed={() => setBrushPopup({ ...brushPopup, detailed: !brushPopup.detailed })} onClose={() => setBrushPopup(null)} setToolOption={setToolOption}/>}
    {movePending && <div className="pending-transform-hint">Enter — Apply (Применить) · Esc — Cancel (Отменить)</div>}
    {activeToolId === "raster.move" && activeLayer3D && orbitGizmoLayerId === activeLayer3D.id && <div className="pending-transform-hint">Enter — Apply (Применить) · Esc — Cancel (Отменить)</div>}
    <div className="canvas-badge">{state.width} × {state.height} · {Math.round(viewport.zoom * 100)}% · {Math.round(viewport.rotation * 10) / 10}° · sRGB · {state.layers.length} layer(s)</div>
    {selectionContextMenu.node}
    {transformContextMenu.node}
    {scene3dMenu.node}
  </div>;
}
