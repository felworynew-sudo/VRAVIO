import { useEffect, useRef } from "react";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { RasterDocumentState, RasterLayer } from "@vravio/env-raster";
import { beginLiveScene3D, type LiveScene3DSession } from "./scene3d-live";
import { updateScene3DLayer } from "./scene3d-commands";

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
 */
export function Scene3DOrbitGizmo({
  documentId, document, layer, zoom, documentOriginX, documentOriginY, onClose,
}: {
  documentId: string;
  document: RasterDocumentState;
  layer: RasterLayer;
  zoom: number;
  documentOriginX: number;
  documentOriginY: number;
  onClose(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let session: LiveScene3DSession | null = null;
    let controls: TransformControls | null = null;

    void beginLiveScene3D(canvas, layer.scene3d!, document).then((liveSession) => {
      if (cancelled) { liveSession.dispose(); return; }
      session = liveSession;
      controls = new TransformControls(liveSession.camera, canvas);
      controls.setMode("rotate");
      controls.setSize(1.1);
      controls.attach(liveSession.rig);
      liveSession.scene.add(controls.getHelper());
      controls.addEventListener("change", () => liveSession.render());
      controls.addEventListener("mouseUp", () => {
        const rotation = liveSession.rig.rotation;
        void updateScene3DLayer(documentId, layer.id, {
          rotationX: rotation.x * 180 / Math.PI, rotationY: rotation.y * 180 / Math.PI, rotationZ: rotation.z * 180 / Math.PI,
        });
      });
      liveSession.render();
    });

    // Escape closes the gizmo the same way every other pending-edit
    // overlay in this project does (move.tsx's own pending transform).
    // Ignored while the gizmo's own drag is in progress — matches
    // `PendingTransform`'s convention of not letting a global key handler
    // race an active gesture.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || controls?.dragging) return;
      event.preventDefault();
      onCloseRef.current();
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
