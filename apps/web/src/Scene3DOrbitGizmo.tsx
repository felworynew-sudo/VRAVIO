import { useEffect, useRef } from "react";
import { Box3, Vector3, type Object3D } from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { RasterDocumentState, RasterLayer } from "@vravio/env-raster";
import { beginLiveScene3D, type LiveScene3DSession } from "./scene3d-live";
import { scene3dOffset } from "./scene3d-commands";

/**
 * Blender-style rotation manipulators for a 3D layer — the owner tried the
 * first version (two linear "-------o------" sliders under/beside the
 * layer) live and asked for them to come off, replaced with what Blender's
 * own rotate tool shows on an object: a sphere of colored rings, one per
 * axis, dragged directly.
 *
 * Not hand-built from Blender's own source (its gizmo is C++/OpenGL,
 * internal to Blender's own viewport draw manager — porting the drawing
 * code itself does not cross into a Three.js/React web app in any useful
 * sense). What *does* cross over cleanly: `three/addons/controls/
 * TransformControls.js`, already vendored in this exact project (the other
 * `three/addons/*` loaders were already imported for text/model 3D layers)
 * and explicitly modeled on the same Blender/Maya axis-gizmo convention —
 * red/green/blue rings for X/Y/Z, a free-rotate outer ring, hover
 * highlighting, screen-constant size regardless of camera distance. It
 * already owns its own pointer handling and raycasting; this component's
 * only job is wiring it to a live Three.js session and committing the
 * result once the drag ends.
 *
 * Entered by choosing "Rotate 3D Object" from the layer's own context
 * menu (RasterWorkspace.tsx / DockLayout.tsx) — not shown by default the
 * way the linear sliders were, per the owner's own request.
 *
 * Behaves like Free Transform now, at the owner's own request: nothing is
 * written to the document while dragging — only this component's own live
 * Three.js session moves — and the drag's result only lands through
 * `onAccept` (Enter, the options bar's own ✓, or clicking away, all wired
 * up by `RasterWorkspace.tsx`) or is thrown away through `onCancel`
 * (Escape / ×). The previous version committed through `updateScene3DLayer`
 * on every single mouse-up: harmless for one drag, but a second drag
 * started before the first commit's own `renderScene3DLayerPixels` (a real
 * WebGL render, not instant) had finished let two of those async commits
 * race, and the loser could land after the winner and silently revert the
 * rotation — the likely source of the reported "gizmo just disappears,
 * cause unclear", since a layer whose kind/state briefly looked
 * inconsistent under that race would fail this component's own render
 * condition in `RasterWorkspace.tsx` and unmount. One commit per session
 * removes the race outright, not just the symptom.
 */
export interface OrbitGizmoState {
  readonly rotation: { x: number; y: number; z: number };
  /** Document pixels the object has been dragged by during this session. */
  readonly move: { x: number; y: number };
}

/** Rings this many screen pixels in radius at any zoom — interface never scales with the document
 * (CLAUDE.md §1). TransformControls sizes its handles from camera distance × tan(fov), which with
 * the document camera comes to 0.95 × document height world units per `size` quarter. */
const RING_RADIUS_PX = 80;

export function Scene3DOrbitGizmo({
  documentId, document, layer, zoom, documentOriginX, documentOriginY, workspaceWidth, workspaceHeight, onLiveChange, onAccept, onCancel,
}: {
  documentId: string;
  document: RasterDocumentState;
  layer: RasterLayer;
  zoom: number;
  documentOriginX: number;
  documentOriginY: number;
  workspaceWidth: number;
  workspaceHeight: number;
  onLiveChange(state: OrbitGizmoState): void;
  onAccept(): void;
  onCancel(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onLiveChangeRef = useRef(onLiveChange);
  onLiveChangeRef.current = onLiveChange;
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const sessionRef = useRef<LiveScene3DSession | null>(null);
  const controlsRef = useRef<TransformControls | null>(null);
  const moveRef = useRef({ x: 0, y: 0 });

  // Where the object's centre sits relative to the canvas centre: the committed offset (recovered
  // the same way `updateScene3DLayer` does, from `placement` and wherever Move left the layer)
  // plus whatever this session has dragged it by.
  const baseOffset = scene3dOffset(layer, document);
  const viewRef = useRef({ zoom, documentOriginX, documentOriginY, workspaceWidth, workspaceHeight, baseOffset });
  viewRef.current = { zoom, documentOriginX, documentOriginY, workspaceWidth, workspaceHeight, baseOffset };

  const applyView = () => {
    const session = sessionRef.current, view = viewRef.current;
    if (!session) return;
    controlsRef.current?.setSize(RING_RADIUS_PX * 8 / (0.95 * document.height * view.zoom));
    session.setViewport({
      width: view.workspaceWidth, height: view.workspaceHeight, originX: view.documentOriginX, originY: view.documentOriginY, zoom: view.zoom,
      offsetX: view.baseOffset.x + moveRef.current.x, offsetY: view.baseOffset.y + moveRef.current.y,
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let controls: TransformControls | null = null;
    moveRef.current = { x: 0, y: 0 };
    const report = () => {
      const session = sessionRef.current;
      if (!session) return;
      const rotation = session.rig.rotation;
      onLiveChangeRef.current({ rotation: { x: rotation.x * 180 / Math.PI, y: rotation.y * 180 / Math.PI, z: rotation.z * 180 / Math.PI }, move: { ...moveRef.current } });
    };

    void beginLiveScene3D(canvas, layer.scene3d!, document, () => cancelled, "document").then((liveSession) => {
      if (!liveSession) return;
      if (cancelled) { liveSession.dispose(); return; }
      sessionRef.current = liveSession;
      controls = new TransformControls(liveSession.camera, canvas);
      controlsRef.current = controls;
      controls.setMode("rotate");
      // The rotate gizmo's invisible trackball ("XYZE", a sphere half the rings' radius) takes every
      // press inside the rings — exactly where the object is — so dragging the object was
      // impossible (§65.11). Free rotation stays on the outer ring ("E") and the three axis rings.
      // Internal to TransformControls, hence the guarded reach; absent, nothing is removed.
      const rotatePicker = (controls as unknown as { _gizmo?: { picker?: Record<string, Object3D> } })._gizmo?.picker?.rotate;
      for (const trackball of rotatePicker?.children.filter((child) => child.name === "XYZE") ?? []) rotatePicker!.remove(trackball);
      controls.attach(liveSession.rig);
      liveSession.scene.add(controls.getHelper());
      controls.addEventListener("change", () => { liveSession.render(); report(); });
      // Only now: TransformControls' own pointerdown has to run before this component's, so a
      // press on a ring has already become its drag by the time `onPointerDown` asks. Registered
      // at effect time, before the async session resolved, this ran first and read every ring
      // press as "empty space — apply" (found live).
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      applyView();
      // The starting pose, reported once up front, so the options bar's X/Y/Z show the instant
      // the session opens rather than after the first drag tick.
      report();
    });

    // A press on a ring is TransformControls' own (registered first, so `dragging` is already set
    // by the time this runs). A press on the object drags it — the owner's "во время поворота
    // объекта должна быть возможность перетаскивать его"; a press on empty space applies, the way
    // a click outside Free Transform's frame does.
    // Inside the object's on-screen rectangle, not only on its exact surface: letters and thin
    // shapes are mostly gaps, and a press that just missed a stroke was read as "empty space —
    // apply" (found live). Free Transform's frame is the grab area for the same reason.
    const corner = new Vector3();
    const hitsObject = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session) return false;
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width * 2 - 1, y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      session.rig.updateMatrixWorld(true);
      const box = new Box3().setFromObject(session.rig);
      if (box.isEmpty()) return false;
      let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
      for (let index = 0; index < 8; index += 1) {
        corner.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z).project(session.camera);
        left = Math.min(left, corner.x); right = Math.max(right, corner.x); bottom = Math.min(bottom, corner.y); top = Math.max(top, corner.y);
      }
      return x >= left && x <= right && y >= bottom && y <= top;
    };
    let drag: { pointerId: number; x: number; y: number; from: { x: number; y: number } } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || controls?.dragging) return;
      if (hitsObject(event)) {
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, from: { ...moveRef.current } };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      onAcceptRef.current();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (drag && event.pointerId === drag.pointerId) {
        const scale = viewRef.current.zoom;
        moveRef.current = { x: drag.from.x + (event.clientX - drag.x) / scale, y: drag.from.y + (event.clientY - drag.y) / scale };
        applyView();
        report();
        return;
      }
      if (!controls?.dragging && !controls?.axis) canvas.style.cursor = hitsObject(event) ? "move" : "";
    };
    const onPointerUp = (event: PointerEvent) => {
      if (drag && event.pointerId === drag.pointerId) drag = null;
    };

    // Enter accepts, Escape discards — the same pair every settled-but-uncommitted edit in this
    // project uses. Ignored mid-drag, so a key cannot race an active gesture.
    const onKeyDown = (event: KeyboardEvent) => {
      if (controls?.dragging || drag) return;
      if (event.key === "Enter") { event.preventDefault(); onAcceptRef.current(); }
      else if (event.key === "Escape") { event.preventDefault(); onCancelRef.current(); }
    };
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      controls?.dispose();
      controlsRef.current = null;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, documentId]);

  // Pan, zoom and a resized workspace only move the view window; nothing is rebuilt.
  useEffect(applyView, [zoom, documentOriginX, documentOriginY, workspaceWidth, workspaceHeight, baseOffset.x, baseOffset.y]);

  // The whole workspace, not the canvas: an object turned or dragged past the canvas edge, and
  // the rings around it, stay visible (§65.11). It used to be a canvas-sized element, which cut
  // both off at the edge.
  return <canvas ref={canvasRef} className="scene3d-live-canvas"
    style={{ left: 0, top: 0, width: workspaceWidth, height: workspaceHeight, pointerEvents: "auto" }} />;
}
