import { useEffect, useRef, useState, type RefObject } from "react";
import type React from "react";
import { clampZoom, spaceZoomFrom, zoomAroundClient } from "./raster-coordinates";
import { rasterToolById } from "./environments/raster/tools/registry";
import type { NavigationContext, NavigationGesture } from "./environments/raster/tools/types";
import { useShellStore, type DocumentViewport } from "./store";

/**
 * The navigation layer: capture-phase pointer handlers on the *workspace*
 * element, so a view gesture claims the pointer before the canvas underneath
 * sees it.
 *
 * That is deliberate and is why `hand`, `zoom` and `rotateView` could not join
 * the tool catalogue with the rest of stage 5: dragging the grey surround
 * around the canvas has to pan too, and the canvas's own handlers never fire
 * out there. They are catalogue tools now, driven through `NavigationHooks`
 * (see environments/raster/tools/types.ts) rather than through the canvas
 * bridge — what used to be a chain of `activeToolId === "…"` tests here is a
 * lookup, and what each of them *does* lives in its own file.
 *
 * What stays here is everything that is not the active tool: the space bar and
 * the middle mouse button as a temporary hand, space-plus-modifier as a
 * temporary zoom, the wheel, and "fit to window". None of those are a tool
 * being chosen — they override whichever tool is. They run the same hooks, so
 * "space is a temporary hand tool" is not an imitation of the hand tool; it is
 * the hand tool.
 */

/** How far the pointer must travel before a press counts as a drag. */
const DRAG_THRESHOLD = 3;

/** A view gesture in progress, and which tool's hooks are driving it. */
interface ActiveNavigation {
  readonly toolId: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly initial: DocumentViewport;
  /** Overrides the tool's own options while the host is driving it — see the
   * space-zoom note in `beginNavigation`. */
  readonly options: Readonly<Record<string, string | number | boolean>>;
  readonly altKey: boolean;
  moved: boolean;
}

export function useCanvasNavigation(params: {
  documentId: string;
  workspaceRef: RefObject<HTMLDivElement | null>;
  viewport: DocumentViewport;
  activeToolId: string | undefined;
  toolOptions: Record<string, Record<string, string | number | boolean>>;
  documentWidth: number;
  documentHeight: number;
}) {
  const { documentId, workspaceRef, viewport, activeToolId, toolOptions, documentWidth, documentHeight } = params;
  const setViewport = useShellStore((shell) => shell.setViewport);
  const navigationGesture = useRef<ActiveNavigation | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  /** "in" or "out" while space and a modifier turn the pointer into a zoom tool. */
  const [spaceZoom, setSpaceZoom] = useState<"in" | "out" | null>(null);
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });

  // "Fit to window" — recomputed whenever the workspace element resizes or
  // the document's own size/rotation changes, as long as the viewport is
  // still in "fit" mode (a manual pan/zoom/rotate switches it to "custom",
  // see the gesture handlers below, and this effect then leaves it alone).
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || viewport.mode !== "fit") return;
    const fit = () => {
      const rect = workspace.getBoundingClientRect();
      const radians = viewport.rotation * Math.PI / 180;
      const cosine = Math.abs(Math.cos(radians)), sine = Math.abs(Math.sin(radians));
      const rotatedWidth = documentWidth * cosine + documentHeight * sine;
      const rotatedHeight = documentWidth * sine + documentHeight * cosine;
      const zoom = clampZoom(Math.min(Math.max(1, rect.width - 80) / rotatedWidth, Math.max(1, rect.height - 80) / rotatedHeight));
      const current = useShellStore.getState().viewports[documentId] ?? viewport;
      if (Math.abs(current.zoom - zoom) > 0.0001 || current.panX !== 0 || current.panY !== 0) setViewport(documentId, { zoom, panX: 0, panY: 0 });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [documentId, setViewport, documentHeight, documentWidth, viewport.mode, viewport.rotation]);

  useEffect(() => {
    const workspace = workspaceRef.current; if (!workspace) return;
    const measure = () => { const rect = workspace.getBoundingClientRect(); setWorkspaceSize((current) => current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(workspace); return () => observer.disconnect();
  }, [workspaceRef]);

  // The navigator needs the size of the visible area to draw its viewport frame. Publishing it
  // as an event keeps the measurement out of the shell store, which would otherwise re-render
  // every panel on each resize frame.
  useEffect(() => {
    const publish = () => window.dispatchEvent(new CustomEvent("vravio-viewport-metrics", { detail: { documentId, workspaceWidth: workspaceSize.width, workspaceHeight: workspaceSize.height } }));
    publish();
    window.addEventListener("vravio-viewport-metrics-request", publish);
    return () => window.removeEventListener("vravio-viewport-metrics-request", publish);
  }, [documentId, workspaceSize.width, workspaceSize.height]);
  /** Space's own state, so a modifier pressed after it can be read without a re-render. */
  const spaceDown = useRef(false);

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
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") { spaceDown.current = false; setSpaceHeld(false); setSpaceZoom(null); }
      else if (spaceDown.current) setSpaceZoom(spaceZoomFrom(event));
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => { window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); };
  }, []);

  /** Builds the context a navigation tool is given. `zoomAround` is a method
   * so the tool never has to know the workspace element exists. */
  const contextFor = (options: Readonly<Record<string, string | number | boolean>>): NavigationContext => ({
    viewport,
    options,
    setViewport: (patch) => setViewport(documentId, patch),
    zoomAround: (zoom, clientX, clientY, from) => {
      const workspace = workspaceRef.current;
      if (workspace) setViewport(documentId, zoomAroundClient(workspace, from ?? viewport, zoom, clientX, clientY));
    },
  });

  const gestureFrom = (current: ActiveNavigation, event: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }): NavigationGesture => ({
    pointerId: current.pointerId,
    startX: current.startX,
    startY: current.startY,
    clientX: event.clientX,
    clientY: event.clientY,
    dx: event.clientX - current.startX,
    dy: event.clientY - current.startY,
    moved: current.moved,
    // The gesture keeps the Alt it started with: releasing Alt mid-drag must
    // not turn a zoom-out into a zoom-in halfway through.
    altKey: current.altKey,
    shiftKey: event.shiftKey,
    initial: current.initial,
  });

  const beginNavigation = (event: React.PointerEvent<HTMLDivElement>) => {
    // Which tool drives this gesture. The temporary overrides come first
    // because they are exactly that — they beat whatever tool is selected.
    const temporaryHand = (spaceHeld && !spaceZoom) || event.button === 1;
    const toolId = spaceZoom ? "raster.zoom" : temporaryHand ? "raster.hand" : activeToolId;
    const hooks = toolId ? rasterToolById.get(toolId)?.navigation : undefined;
    if (!hooks) return;

    event.preventDefault(); event.stopPropagation();

    // A temporary zoom is always a click zoom, never a scrubby drag: a
    // modifier held down with the space bar is a momentary thing. Handing the
    // tool `dragZoom: false` says that in the tool's own language rather than
    // forking its behaviour out here — and `altKey` carries the direction the
    // modifier chose, which is the same question the tool already asks.
    const options = spaceZoom
      ? { dragZoom: false }
      : { ...toolOptions[toolId!], ...(toolOptions[toolId!]?.dragZoom === undefined ? { dragZoom: useShellStore.getState().preferences.dragZoom } : {}) };
    const altKey = spaceZoom ? spaceZoom === "out" : event.altKey;

    const current: ActiveNavigation = { toolId: toolId!, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, initial: { ...viewport }, options, altKey, moved: false };
    if (hooks.begin(contextFor(options), gestureFrom(current, { ...event, altKey })) === "done") return;

    event.currentTarget.setPointerCapture(event.pointerId);
    navigationGesture.current = current;
    setNavigating(true);
  };

  const moveNavigation = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = navigationGesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    current.moved ||= Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > DRAG_THRESHOLD;
    rasterToolById.get(current.toolId)?.navigation?.move?.(contextFor(current.options), gestureFrom(current, event));
  };

  const endNavigation = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = navigationGesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    rasterToolById.get(current.toolId)?.navigation?.end?.(contextFor(current.options), gestureFrom(current, event));
    navigationGesture.current = null;
    setNavigating(false);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || event.altKey) {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const zoom = clampZoom(viewport.zoom * Math.exp(-event.deltaY * 0.002));
      setViewport(documentId, zoomAroundClient(workspace, viewport, zoom, event.clientX, event.clientY));
    } else setViewport(documentId, { panX: viewport.panX - (event.shiftKey ? event.deltaY : event.deltaX), panY: viewport.panY - (event.shiftKey ? 0 : event.deltaY), mode: "custom" });
  };

  return { navigating, spaceHeld, spaceZoom, workspaceSize, beginNavigation, moveNavigation, endNavigation, handleWheel };
}
