import { useEffect, useRef, useState, type RefObject } from "react";
import type React from "react";
import { clampZoom, spaceZoomFrom, zoomAroundClient } from "./raster-coordinates";
import { useShellStore, type DocumentViewport } from "./store";

/**
 * Pan/zoom/rotate for `RasterWorkspace.tsx`'s canvas — split out purely to
 * bring the host component's own line count down (docs/migration-plan.md
 * §8), not because any of this changed: the gesture (capture-phase pointer
 * handlers on the workspace element, so navigation wins before a tool's own
 * canvas handlers see the event), the space-bar-as-temporary-hand-tool
 * behaviour and its Photoshop-style zoom-modifier reading, and the
 * click-to-zoom-without-drag fallback are all read verbatim off the
 * pre-extraction code.
 */

interface NavigationGesture {
  readonly kind: "pan" | "rotate" | "zoom";
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly initial: DocumentViewport;
  readonly alt: boolean;
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
  const navigationGesture = useRef<NavigationGesture | null>(null);
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
        setViewport(documentId, zoomAroundClient(workspace, viewport, zoom, event.clientX, event.clientY));
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
    if (current.kind === "pan") setViewport(documentId, { panX: current.initial.panX + dx, panY: current.initial.panY + dy, mode: "custom" });
    else if (current.kind === "rotate") {
      const raw = current.initial.rotation + dx * 0.3;
      setViewport(documentId, { rotation: event.shiftKey ? Math.round(raw / 15) * 15 : raw, mode: "custom" });
    } else {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const zoom = clampZoom(current.initial.zoom * Math.exp(dx * 0.01));
      setViewport(documentId, zoomAroundClient(workspace, current.initial, zoom, current.startX, current.startY));
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
        setViewport(documentId, zoomAroundClient(workspace, current.initial, zoom, event.clientX, event.clientY));
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
      setViewport(documentId, zoomAroundClient(workspace, viewport, zoom, event.clientX, event.clientY));
    } else setViewport(documentId, { panX: viewport.panX - (event.shiftKey ? event.deltaY : event.deltaX), panY: viewport.panY - (event.shiftKey ? 0 : event.deltaY), mode: "custom" });
  };

  return { navigating, spaceHeld, spaceZoom, workspaceSize, beginNavigation, moveNavigation, endNavigation, handleWheel };
}
