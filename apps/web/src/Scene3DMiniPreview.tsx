import { useEffect, useRef } from "react";
import type { RasterDocumentState, Scene3DLayerData } from "@vravio/env-raster";
import { beginLiveScene3D, type LiveScene3DSession } from "./scene3d-live";

/**
 * The Properties panel's own small live preview — the owner's own sketch
 * for the 3D layer panel redesign: a mini render of the model in the
 * middle, rotation dials to its left, light dials to its right, all
 * reflecting the same `Scene3DLayerData` DockLayout's other controls
 * already edit.
 *
 * Reuses the exact persistent-session door the rotate/shadow gizmos do
 * (`beginLiveScene3D`) rather than the one-shot `renderScene3DLayerPixels`
 * every other Properties-panel slider commits through: a session lets
 * rotation and lighting changes retune the *running* scene in place
 * (`setRotation`/`setLighting`, no rebuild), which is what keeps a dial
 * drag here smooth. Only a change that could touch the mesh itself —
 * source, size, or a baked-in material property (color/metalness/
 * roughness, all embedded in the mesh at build time by
 * `buildGeometrySource`) — actually rebuilds the session; the fields this
 * file's own dials touch (rotation, light azimuth/elevation/intensity)
 * never do.
 */

const SIZE = 156;

function materialKey(data: Scene3DLayerData): string {
  return JSON.stringify([data.source, data.size, data.color, data.metalness, data.roughness]);
}

export function Scene3DMiniPreview({ document, data }: { document: RasterDocumentState; data: Scene3DLayerData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<LiveScene3DSession | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void beginLiveScene3D(canvas, dataRef.current, document, () => cancelled).then((session) => {
      if (!session) return;
      if (cancelled) { session.dispose(); return; }
      sessionRef.current = session;
      if (dataRef.current.ground?.enabled) session.setGround(dataRef.current.ground);
      session.render();
    });
    return () => { cancelled = true; sessionRef.current?.dispose(); sessionRef.current = null; };
    // Rebuilds only when the mesh itself could have changed — see the module doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, materialKey(data)]);

  useEffect(() => { sessionRef.current?.setRotation(data.rotationX, data.rotationY, data.rotationZ); }, [data.rotationX, data.rotationY, data.rotationZ]);
  useEffect(() => { sessionRef.current?.setLighting(data.lighting); }, [data.lighting]);
  useEffect(() => { sessionRef.current?.setGround(data.ground); }, [data.ground]);

  return <canvas ref={canvasRef} width={SIZE} height={SIZE} className="scene3d-mini-preview"/>;
}
