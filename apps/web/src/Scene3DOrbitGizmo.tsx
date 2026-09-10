import { useEffect, useRef } from "react";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { RasterDocumentState, RasterLayer } from "@vravio/env-raster";
import { beginLiveScene3D, type LiveScene3DSession } from "./scene3d-live";

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
export function Scene3DOrbitGizmo({
  documentId, document, layer, zoom, documentOriginX, documentOriginY, onLiveChange, onAccept, onCancel,
}: {
  documentId: string;
  document: RasterDocumentState;
  layer: RasterLayer;
  zoom: number;
  documentOriginX: number;
  documentOriginY: number;
  onLiveChange(rotation: { x: number; y: number; z: number }): void;
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let session: LiveScene3DSession | null = null;
    let controls: TransformControls | null = null;

    void beginLiveScene3D(canvas, layer.scene3d!, document, () => cancelled).then((liveSession) => {
      if (!liveSession) return;
      if (cancelled) { liveSession.dispose(); return; }
      session = liveSession;
      controls = new TransformControls(liveSession.camera, canvas);
      controls.setMode("rotate");
      controls.setSize(1.1);
      controls.attach(liveSession.rig);
      liveSession.scene.add(controls.getHelper());
      const reportRotation = () => {
        const rotation = liveSession.rig.rotation;
        onLiveChangeRef.current({ x: rotation.x * 180 / Math.PI, y: rotation.y * 180 / Math.PI, z: rotation.z * 180 / Math.PI });
      };
      controls.addEventListener("change", () => { liveSession.render(); reportRotation(); });
      liveSession.render();
      // The starting pose, reported once up front — otherwise the options bar's own X/Y/Z readout
      // (and RasterWorkspace's own pending-rotation ref, read back on commit) would stay empty
      // until the very first drag tick, the same way Free Transform's own X/Y/W/H appear the
      // instant it starts rather than only once something has actually moved.
      reportRotation();
    });

    // Enter accepts, Escape discards — the same pair every settled-but-uncommitted edit in this
    // project uses (move.tsx's own pending transform). Both ignored while the gizmo's own drag is
    // in progress, matching `PendingTransform`'s convention of not letting a global key handler
    // race an active gesture.
    const onKeyDown = (event: KeyboardEvent) => {
      if (controls?.dragging) return;
      if (event.key === "Enter") { event.preventDefault(); onAcceptRef.current(); }
      else if (event.key === "Escape") { event.preventDefault(); onCancelRef.current(); }
    };
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      controls?.dispose();
      session?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, documentId]);

  return <canvas ref={canvasRef} className="scene3d-live-canvas" width={document.width} height={document.height}
    style={{ left: documentOriginX, top: documentOriginY, width: document.width * zoom, height: document.height * zoom, pointerEvents: "auto" }} />;
}
